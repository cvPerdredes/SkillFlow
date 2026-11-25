"""组件级测试：使用模拟Chrome消息接口，并不等于浏览器扩展端到端测试。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

with sync_playwright() as p:
    launch_kwargs = {"headless": True, "args": ["--no-sandbox"]}
    linux_chromium = Path("/usr/bin/chromium")
    if linux_chromium.exists():
        launch_kwargs["executable_path"] = str(linux_chromium)
    browser = p.chromium.launch(**launch_kwargs)
    page = browser.new_page()
    page.set_content((ROOT / "demo-site/index.html").read_text(encoding="utf-8"))
    page.evaluate(
        """() => {
      window.__events = [];
      window.__onMessage = () => {};
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        id: 'test-extension',
        sendMessage: async (m) => { window.__events.push(m); return { ok: true }; },
        onMessage: { addListener: (fn) => { window.__onMessage = fn; } }
      };
    }"""
    )
    page.add_script_tag(path=str(ROOT / "extension/content.js"))
    res = page.evaluate(
        """() => new Promise(done => window.__onMessage({ type: 'SET_RECORDING', enabled: true }, {}, done))"""
    )
    assert res["ok"]

    page.locator("#unit").fill("A单位")
    page.locator("#month").fill("2026-10")
    page.locator("#query").click()
    captured = page.evaluate("window.__events.map(x => x.step)")
    assert any(e["action"] == "fill" and e.get("value") == "A单位" for e in captured)
    assert any(e["action"] == "fill" and e.get("value") == "2026-10" for e in captured)
    assert any(e["action"] == "click" and e.get("target", {}).get("css") == "#query" for e in captured)

    page.evaluate(
        """() => {
      const x = document.createElement('input');
      x.type = 'password';
      x.id = 'test-pass';
      document.body.append(x);
    }"""
    )
    page.locator("#test-pass").fill("TEST_SECRET_MUST_NOT_BE_SAVED")
    page.locator("#query").click()
    captured = page.evaluate("window.__events.map(x => x.step)")
    assert "TEST_SECRET_MUST_NOT_BE_SAVED" not in json.dumps(captured)
    assert any(e["action"] == "auth_checkpoint" for e in captured)

    for selector, value in [("#unit", "B单位"), ("#month", "2026-11")]:
        step = {"action": "fill", "target": {"css": selector}, "value": value}
        res = page.evaluate(
            """step => new Promise(done => window.__onMessage({ type: 'PLAY_STEP', step }, {}, done))""",
            step,
        )
        assert res["ok"], res

    res = page.evaluate(
        """() => new Promise(done => window.__onMessage({ type: 'PLAY_STEP', step: { action: 'click', target: { css: '#query' } } }, {}, done))"""
    )
    assert res["ok"], res

    final = page.locator("#result").inner_text()
    assert "B单位" in final and "2026-11" in final, final
    checked = page.evaluate(
        """() => new Promise(done => window.__onMessage({ type: 'GET_RESULT', selector: '#result' }, {}, done))"""
    )
    assert checked["found"] and checked["status"] == "ok", checked
    page.screenshot(path=str(ROOT / "tests/demo_verified.png"), full_page=True)
    print("PASS: DOM recording, month input, replay with new values, auth_checkpoint redaction, result check")
    browser.close()
