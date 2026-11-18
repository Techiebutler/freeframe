"""A transcode has to be able to stay out of the way of everything else.

Unbounded, one transcode takes about 10 of 16 cores for the default ladder and
still 9 for a single rung -- so `TRANSCODER_QUALITIES` is not a way to get the
machine back, and a self-host has nothing to reach for. `TRANSCODER_CPU_LIMIT`
is that lever.

Two properties are worth pinning beyond the arithmetic:

  1. **Unset changes nothing.** The setting has to be invisible to every
     deployment that does not use it, down to the ffmpeg arguments.
  2. **A bad value does not stop transcoding.** It gets written when the machine
     is already struggling, so the cost of a typo must be a line in the log --
     not every upload failing through the retry ladder, which is the shape #325
     already had to fix once for the ladder itself.
"""
import pytest

from packages.transcoder.ffmpeg_transcoder import (
    available_cpus, get_cpu_budget, parse_cpu_budget, thread_plan,
)


# ------------------------------------------------------------- absolute counts

def test_a_core_count_is_taken_as_written():
    assert parse_cpu_budget("6", cpu_count=16) == 6


def test_surrounding_whitespace_is_tolerated():
    # Pasted out of a compose file, this is what an operator actually types.
    # Pinning the contract, not the `.strip()`: `int()` strips for itself, so
    # removing that call leaves this green. What it does redden is the blank
    # case and the `%` suffix check, which have their own tests.
    assert parse_cpu_budget("  6  ", cpu_count=16) == 6


def test_asking_for_every_core_is_the_same_as_asking_for_nothing(capsys):
    # Honesty rather than a no-op limit: someone who writes 16 on a 16-core box
    # believes a cap is in force, and would otherwise never learn it is not.
    assert parse_cpu_budget("16", cpu_count=16) is None
    assert "leaving CPU use unbounded" in capsys.readouterr().out


def test_asking_for_more_than_exists_is_also_unbounded(capsys):
    assert parse_cpu_budget("64", cpu_count=16) is None
    assert "64 of 16 available" in capsys.readouterr().out


# ------------------------------------------------------------------- shares

def test_a_percentage_is_read_against_what_is_available():
    assert parse_cpu_budget("50%", cpu_count=16) == 8


def test_a_percentage_is_rounded_not_truncated():
    # 35% of 16 is 5.6. Truncation would hand out 5 and quietly give the
    # operator less than they asked for, every time the share does not divide
    # evenly -- which is most of the time.
    assert parse_cpu_budget("35%", cpu_count=16) == 6
    assert parse_cpu_budget("40%", cpu_count=4) == 2      # 1.6
    # A share that lands exactly on a core is unaffected either way.
    assert parse_cpu_budget("50%", cpu_count=16) == 8


def test_a_percentage_never_rounds_down_to_nothing():
    # Separate from the rounding above, and separately mutable: on a small box
    # a share under half a core would otherwise resolve to zero, which ffmpeg
    # reads as "pick for yourself" -- so the quietest setting available would
    # be the one that caps nothing at all.
    assert parse_cpu_budget("1%", cpu_count=8) == 1
    assert parse_cpu_budget("10%", cpu_count=4) == 1      # 0.4


def test_a_comma_decimal_is_accepted():
    # A German-locale operator writes 12,5 and means twelve and a half.
    assert parse_cpu_budget("12,5%", cpu_count=16) == 2


def test_whitespace_inside_a_share_is_tolerated():
    # The space before the `%` is `float()`'s to strip, not ours; the space
    # after it is what the outer strip has to remove before `endswith("%")`
    # can see the suffix, and that is the half of this the test can redden.
    assert parse_cpu_budget(" 25 % ", cpu_count=16) == 4


def test_a_full_share_is_unbounded(capsys):
    assert parse_cpu_budget("100%", cpu_count=16) is None
    assert "leaving CPU use unbounded" in capsys.readouterr().out


# ------------------------------------------------------------ the unset case

@pytest.mark.parametrize("raw", [None, "", "   "])
def test_unset_is_unbounded_and_says_nothing(raw, capsys):
    # Silence matters here: this is every deployment that never touched the
    # setting, and a line per transcode would be noise in all of them.
    assert parse_cpu_budget(raw, cpu_count=16) is None
    assert capsys.readouterr().out == ""


def test_get_cpu_budget_reads_the_environment(monkeypatch):
    # The core count is pinned rather than taken from whatever is running the
    # suite: a budget at or above what is available resolves to unbounded on
    # purpose, so 4 would mean "no limit" on a four-core CI runner and this
    # would fail for a reason that has nothing to do with reading the env.
    monkeypatch.setattr(
        "packages.transcoder.ffmpeg_transcoder.available_cpus", lambda: 16
    )
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "4")
    assert get_cpu_budget() == 4
    monkeypatch.delenv("TRANSCODER_CPU_LIMIT")
    assert get_cpu_budget() is None


# --------------------------------------------------------------- typo cases

@pytest.mark.parametrize("raw", ["six", "6 cores", "abc%", "%", "--4"])
def test_an_unusable_value_falls_back_and_reports(raw, capsys):
    assert parse_cpu_budget(raw, cpu_count=16) is None
    assert "TRANSCODER_CPU_LIMIT" in capsys.readouterr().out


@pytest.mark.parametrize("raw", ["0", "-1", "0%", "-5%"])
def test_a_value_leaving_no_cores_falls_back_and_reports(raw, capsys):
    assert parse_cpu_budget(raw, cpu_count=16) is None
    assert "would leave no cores" in capsys.readouterr().out


@pytest.mark.parametrize("raw", ["nan%", "inf%", "Infinity%", "-inf%"])
def test_a_share_that_is_not_a_number_falls_back_rather_than_raising(raw, capsys):
    # The typo cases above are all strings `float()` rejects. These four it
    # accepts, and three of them used to reach `round()`, where NaN raises
    # ValueError and inf raises OverflowError. Nothing between there and the
    # job's outer handler catches either, so a single mistyped share failed
    # every upload at 0% with an error that never named this setting -- the
    # exact outcome the fallback exists to prevent.
    assert parse_cpu_budget(raw, cpu_count=16) is None
    assert "TRANSCODER_CPU_LIMIT" in capsys.readouterr().out


# ------------------------------------------------------------- the thread plan

def test_no_budget_means_no_arguments():
    # The whole point of the unset case: the command has to come out byte for
    # byte as it did before this setting existed.
    assert thread_plan(None, 3) is None


def test_a_budget_is_split_across_the_rungs():
    per_rung, filter_threads = thread_plan(6, 3)
    assert per_rung == [2, 2, 2]
    assert sum(per_rung) == 6
    assert filter_threads == 3


def test_a_remainder_goes_to_the_largest_rungs():
    # Rungs are ordered largest first, and the largest is the slowest to encode,
    # so it is the one that should get the spare thread.
    per_rung, _ = thread_plan(7, 3)
    assert per_rung == [3, 2, 2]
    assert sum(per_rung) == 7


def test_a_single_rung_gets_the_whole_budget():
    per_rung, _ = thread_plan(6, 1)
    assert per_rung == [6]


def test_the_filter_graph_gets_half_the_budget():
    # This said "one thread whatever the budget" until the measurement behind it
    # was repeated on something other than a 1080p SDR source. One thread makes
    # the graph the bottleneck on anything that has real scaling or tone-mapping
    # to do: on a 4K HDR source a budget of six cores occupied 1.65 of them and
    # took 101.5s, against 3.68 and 51.1s at half the budget. The whole budget
    # is faster again (30.5s) and overruns the cap on both 4K sources, so half
    # is the largest share that stayed inside it on all three.
    assert thread_plan(6, 3)[1] == 3
    assert thread_plan(12, 3)[1] == 6
    # Never zero: budget // 2 is 0 below two cores, and `-filter_complex_threads
    # 0` is not a slower graph, it is the unbounded graph. ffmpeg accepts it and
    # reads zero as "pick for yourself", so the floor is what keeps the smallest
    # budget from being the one that caps nothing.
    assert thread_plan(1, 3)[1] == 1
    assert thread_plan(2, 3)[1] == 1


def test_a_budget_below_the_rung_count_keeps_every_rung_alive(capsys):
    # Three rungs cannot run on two threads: a rung with zero threads is not a
    # slower rung, it is an unbounded one, since ffmpeg reads zero as "pick for
    # yourself". The floor is honoured and reported rather than silently
    # exceeded -- overrunning the budget by one core is the smaller harm.
    per_rung, _ = thread_plan(2, 3)
    assert per_rung == [1, 1, 1]
    out = capsys.readouterr().out
    assert "asks for 2 core(s)" in out
    assert "using 3" in out


def test_a_budget_that_fits_exactly_says_nothing(capsys):
    thread_plan(3, 3)
    assert capsys.readouterr().out == ""


# --------------------------------------------------------------- availability

def test_available_cpus_is_at_least_one():
    # Whatever the sandbox, a number below one would make every downstream
    # share resolve to zero threads.
    assert available_cpus() >= 1


def test_a_share_defaults_to_what_is_available(monkeypatch):
    monkeypatch.setattr(
        "packages.transcoder.ffmpeg_transcoder.available_cpus", lambda: 8
    )
    assert parse_cpu_budget("25%") == 2


def test_a_cgroup_quota_wins_over_the_host_core_count(monkeypatch):
    # The case this exists for: a worker already capped at 4 of 16 with `cpus:`
    # asks for 50%. os.cpu_count() reports the *host's* cores inside a
    # container, so reading that would hand out 8 -- twice what the worker has,
    # and the operator would never see why the cap did nothing.
    import packages.transcoder.ffmpeg_transcoder as mod

    def fake_read_text(self, *args, **kwargs):
        if str(self) == "/sys/fs/cgroup/cpu.max":
            return "400000 100000\n"          # 4 cores' worth of quota
        raise OSError("not here")

    monkeypatch.setattr(mod.Path, "read_text", fake_read_text)
    # Same reason as the v1 test below: without pinning what the code falls
    # through to, deleting the cgroup read leaves the assertion satisfied by the
    # host's own count on any four-CPU machine, which is what `ubuntu-latest`
    # is, so the mutation would die on a roomy dev box and survive here. CI
    # would still have gone red, by way of `test_a_sub_core_quota_still_yields_one`
    # -- the point is that this test, which is named for the quota, has to be
    # the one that catches it.
    monkeypatch.setattr(mod.os, "sched_getaffinity", lambda _pid: set(range(9)),
                        raising=False)
    assert mod.available_cpus() == 4
    assert mod.parse_cpu_budget("50%") == 2


def test_an_unlimited_cgroup_falls_through_to_the_real_core_count(monkeypatch):
    # "max" is what an uncapped container reads, and it must not be mistaken
    # for a quota of zero.
    import packages.transcoder.ffmpeg_transcoder as mod

    def fake_read_text(self, *args, **kwargs):
        if str(self) == "/sys/fs/cgroup/cpu.max":
            return "max 100000\n"
        raise OSError("not here")

    monkeypatch.setattr(mod.Path, "read_text", fake_read_text)
    # raising=False because sched_getaffinity is Linux-only: on macOS the
    # attribute does not exist and monkeypatch would fail the test before it
    # ran. The production guard for that same absence is a real one and is
    # covered by
    # `test_a_host_without_sched_getaffinity_falls_back_to_the_core_count`
    # below, which did not exist when this sentence was first written.
    monkeypatch.setattr(mod.os, "sched_getaffinity", lambda _pid: set(range(12)),
                        raising=False)
    assert mod.available_cpus() == 12


def test_a_sub_core_quota_still_yields_one(monkeypatch):
    # `cpus: "0.5"` is legal. A budget of zero is not a slower encode, it is an
    # unbounded one: ffmpeg reads a zero thread count as "pick for yourself".
    import packages.transcoder.ffmpeg_transcoder as mod

    def fake_read_text(self, *args, **kwargs):
        if str(self) == "/sys/fs/cgroup/cpu.max":
            return "50000 100000\n"
        raise OSError("not here")

    monkeypatch.setattr(mod.Path, "read_text", fake_read_text)
    assert mod.available_cpus() == 1


# --- cgroup v1 ----------------------------------------------------------
# The v1 pair is read for hosts that have not moved to v2, and until these
# three tests existed nothing covered it in either direction: deleting the v1
# tuple entirely left the suite green.

_V1_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"
_V1_PERIOD = "/sys/fs/cgroup/cpu/cpu.cfs_period_us"


def _only_v1(quota: str, period: str = "100000\n"):
    """A host with no cgroup v2 file and the given v1 pair."""
    def fake_read_text(self, *args, **kwargs):
        if str(self) == _V1_QUOTA:
            return quota
        if str(self) == _V1_PERIOD:
            return period
        raise OSError("not here")
    return fake_read_text


def test_a_cgroup_v1_quota_is_read(monkeypatch):
    # 400000/100000 is `cpus: 4` as cgroup v1 writes it.
    #
    # The affinity patch is what makes this a test. Without it the assertion is
    # satisfied by the fall-through on any host that reports four available
    # CPUs, which `ubuntu-latest` does, so deleting the v1 tuple would stay
    # green in CI while reddening here and on a 16-core box.
    import packages.transcoder.ffmpeg_transcoder as mod

    monkeypatch.setattr(mod.Path, "read_text", _only_v1("400000\n"))
    monkeypatch.setattr(mod.os, "sched_getaffinity", lambda _pid: set(range(9)),
                        raising=False)
    assert mod.available_cpus() == 4


def test_an_unrestricted_cgroup_v1_host_falls_through(monkeypatch):
    # v1 writes -1, not "max", for no limit. Read as a number it is a quota of
    # -1/100000, which clamps to one core -- and then every budget on the box
    # resolves to unbounded, because a budget >= the core count deliberately
    # does. A whole deployment's setting would go silently dead, with one log
    # line to show for it.
    import packages.transcoder.ffmpeg_transcoder as mod

    monkeypatch.setattr(mod.Path, "read_text", _only_v1("-1\n"))
    monkeypatch.setattr(mod.os, "sched_getaffinity", lambda _pid: set(range(8)),
                        raising=False)
    assert mod.available_cpus() == 8


def test_an_unreadable_quota_falls_through_rather_than_raising(monkeypatch):
    # A quota file that is empty or not a number must not take the worker down
    # on a host nobody anticipated. ValueError belongs in the except clause for
    # this, and narrowing it to OSError alone would let this one through.
    import packages.transcoder.ffmpeg_transcoder as mod

    monkeypatch.setattr(mod.Path, "read_text", _only_v1("\n"))
    monkeypatch.setattr(mod.os, "sched_getaffinity", lambda _pid: set(range(3)),
                        raising=False)
    assert mod.available_cpus() == 3


def test_a_host_without_sched_getaffinity_falls_back_to_the_core_count(monkeypatch):
    # The production guard behind every `raising=False` in this file. On a host
    # with no `sched_getaffinity` -- macOS, Windows -- the attribute lookup
    # raises `AttributeError` rather than returning anything, so the except
    # clause has to name it or the worker dies on import of its own core count.
    # Nothing exercised this on Linux, where the attribute always exists.
    import packages.transcoder.ffmpeg_transcoder as mod

    monkeypatch.setattr(mod.Path, "read_text", _only_v1("\n"))   # no cgroup
    monkeypatch.delattr(mod.os, "sched_getaffinity", raising=False)
    monkeypatch.setattr(mod.os, "cpu_count", lambda: 7)
    assert mod.available_cpus() == 7
