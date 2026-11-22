from coldarchive.budget import preview_budget


def test_budget():
    assert preview_budget(3_500_000_000) == 35_000_000
    assert preview_budget(16_932_680_900) == 50_000_000
    assert preview_budget(1_000) == 65_536
