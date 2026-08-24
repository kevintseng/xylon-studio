"""Regression checks for Xylon's public capability boundary."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_retired_fake_result_assets_are_not_published() -> None:
    retired_paths = (
        REPO_ROOT / "curriculum" / "README.md",
        REPO_ROOT / "web" / "public" / "screenshots" / "01-homepage.png",
        REPO_ROOT / "web" / "public" / "screenshots" / "02-design-result.png",
        REPO_ROOT / "web" / "public" / "screenshots" / "03-verify-result.png",
        REPO_ROOT / "web" / "public" / "screenshots" / "04-history.png",
    )

    assert not [path.relative_to(REPO_ROOT) for path in retired_paths if path.exists()]


def test_public_surfaces_state_the_real_openroad_boundary() -> None:
    english_readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    traditional_chinese_readme = (REPO_ROOT / "README.zh-TW.md").read_text(
        encoding="utf-8"
    )
    ui_copy = (REPO_ROOT / "web" / "lib" / "i18n.tsx").read_text(encoding="utf-8")
    public_text = "\n".join((english_readme, traditional_chinese_readme, ui_copy))
    english_copy = " ".join(english_readme.split())
    traditional_chinese_copy = " ".join(traditional_chinese_readme.split())

    assert "OpenROAD adapter is a control-plane boundary" in english_copy
    assert "not an RTL-to-GDS product journey" in english_copy
    assert "OpenROAD 執行紀錄目前只證明受限指令確實執行" in traditional_chinese_copy
    assert "還不能匯入完整的 RTL／SDC／PDK 設計" in traditional_chinese_copy
    assert "或執行並比較時序改善結果" in traditional_chinese_copy
    assert "timing-improvement journey is the next product slice" in ui_copy
    assert "is not available yet" in ui_copy
    assert "RTL、SDC、PDK 的時序診斷與改善流程" in ui_copy
    assert "目前尚未提供" in ui_copy
    assert "94.2%" not in public_text
    assert "AI-generated RTL in seconds" not in public_text
    assert "Production-ready GDSII" not in public_text
