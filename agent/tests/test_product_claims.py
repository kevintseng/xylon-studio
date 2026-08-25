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

    assert "bounded local OpenROAD flow on real RTL and SDC" in english_copy
    assert "built-in `sky130hd`" in english_copy
    assert "Remote BYOK endpoints or stored API keys" in english_copy
    assert "not physical signoff or tape-out readiness" in english_copy
    assert "真實 RTL、SDC" in traditional_chinese_copy
    assert "遠端 BYOK 服務網址或保存 API key" in traditional_chinese_copy
    assert "不等於 timing closure" in traditional_chinese_copy
    assert "所有結果都來自 OpenROAD 讀回，不是模型宣稱" in ui_copy
    assert "任意 PDK／元件庫匯入、遠端 BYOK 模型 endpoint" in ui_copy
    assert "本功能不代表實體驗證完成或可投片" in ui_copy
    assert "OpenROAD adapter is a control-plane boundary" not in public_text
    assert "timing-improvement journey is the next product slice" not in public_text
    assert "還不能匯入完整的 RTL／SDC／PDK 設計" not in public_text
    assert "94.2%" not in public_text
    assert "AI-generated RTL in seconds" not in public_text
    assert "Production-ready GDSII" not in public_text
