"""Brand-name normalisation for matching a brand to its FreeFrame workspace.

Ported verbatim from the Aditor dispatcher (dispatch-agent `freeframe_workspaces._norm`), which
created every brand workspace until the portal took that job over (POST
/integrations/portal/workspace). The rules must stay identical: the existing workspaces were named
by that code and by hand, so a brand only finds its workspace again if both sides collapse to the
same key. Change a rule here and a brand that already has a workspace gets a duplicate.

The existing workspaces are a mix of bare brand names ("ByNoria") and "<Brand> - Workspace" (the
auto-backfilled ones), and brand names carry legal suffixes, parenthetical owners
("mammaly (Peturo GmbH)") and slash aliases ("Glow25 / DailyRituals").
"""
import re

# Brands whose name does not normalise to their existing workspace name by rule alone, keyed by
# the normalised brand name -> the normalised workspace name. Only for genuine same-brand
# mismatches a rule cannot catch; a new brand never needs an entry.
ALIASES = {
    "kellergesundheitspflege": "kellergesundheit",  # "Keller Gesundheitspflege GmbH" == workspace "Keller Gesundheit"
}

# Replaced anywhere in the lowercased name, not only at the end - exactly as the dispatcher did.
_LEGAL_SUFFIXES = (" gmbh", " ug", " co", " kg", " bv", " ltd", " inc", " llc")


def normalize_brand_name(name) -> str:
    """Loose brand-name key: lowercase; drop a parenthetical (...) and any "/ alias" tail; drop
    legal suffixes, non-alphanumerics and a trailing "workspace" token; then apply the alias map."""
    s = (name or "").lower()
    s = re.sub(r"\(.*?\)", " ", s)  # "mammaly (peturo gmbh)" -> "mammaly"
    s = s.split("/")[0]  # "glow25 / dailyrituals" -> "glow25" (a real new brand keeps its own key)
    for suffix in _LEGAL_SUFFIXES:
        s = s.replace(suffix, "")
    s = "".join(c for c in s if c.isalnum())
    if s.endswith("workspace"):
        s = s[: -len("workspace")]
    return ALIASES.get(s, s)
