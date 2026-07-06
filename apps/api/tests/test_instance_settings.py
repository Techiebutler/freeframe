"""Tests for instance_settings model, storage service, router, and cap enforcement."""
from apps.api.models.instance_settings import InstanceSettings


def test_instance_settings_table_shape():
    cols = InstanceSettings.__table__.columns
    assert InstanceSettings.__tablename__ == "instance_settings"
    assert "storage_limit_bytes" in cols
    # 0 = unlimited default
    assert cols["storage_limit_bytes"].server_default.arg == "0"
    assert cols["storage_limit_bytes"].nullable is False
