"""SUPERADMIN_EMAILS: a listed staff person becomes a superadmin on their next signed-in request."""
from types import SimpleNamespace

from apps.api.config import settings
from apps.api.middleware.auth import _promote_listed_superadmin


class _Db:
    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1


def _user(email, staff=True, admin=False):
    return SimpleNamespace(email=email, is_staff=staff, is_superadmin=admin)


def test_listed_staff_becomes_superadmin(monkeypatch):
    monkeypatch.setattr(settings, "superadmin_emails", " Alan@Aditor.ai , x@y.z")
    u, db = _user("alan@aditor.ai"), _Db()
    _promote_listed_superadmin(u, db)
    assert u.is_superadmin is True and db.commits == 1


def test_unlisted_customer_or_empty_list_unchanged(monkeypatch):
    monkeypatch.setattr(settings, "superadmin_emails", "alan@aditor.ai")
    other, customer, db = _user("editor@aditor.ai"), _user("alan@aditor.ai", staff=False), _Db()
    _promote_listed_superadmin(other, db)
    _promote_listed_superadmin(customer, db)
    assert other.is_superadmin is False and customer.is_superadmin is False and db.commits == 0
    monkeypatch.setattr(settings, "superadmin_emails", "")
    u = _user("alan@aditor.ai")
    _promote_listed_superadmin(u, db)
    assert u.is_superadmin is False and db.commits == 0
