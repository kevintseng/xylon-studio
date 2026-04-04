// Demo screenshot automation script
// All injected content is hardcoded mock data for demo purposes only.
// This script is NOT production code — innerHTML usage here is intentional
// and safe because all content is developer-controlled, never from user input.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots');

const VERILOG_CODE = `module adder_8bit (
    input  wire [7:0] a,
    input  wire [7:0] b,
    input  wire       cin,
    output wire [7:0] sum,
    output wire       cout,
    output wire       overflow
);

    wire [8:0] result;

    assign result   = {1'b0, a} + {1'b0, b} + {8'b0, cin};
    assign sum      = result[7:0];
    assign cout     = result[8];
    assign overflow = (a[7] == b[7]) && (sum[7] != a[7]);

endmodule`;

// Build result HTML strings as template functions
function designResultHTML(code) {
  // Escape HTML entities in code for safe display
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `
    <div class="p-6 border border-slate-700 rounded-lg bg-slate-800/50">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-semibold">設計結果</h2>
        <span class="text-xs text-green-400 flex items-center gap-1">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
          已儲存至歷史紀錄
        </span>
      </div>
      <div class="grid md:grid-cols-3 gap-4 mb-6">
        <div class="p-3 bg-slate-800 rounded-lg">
          <p class="text-xs text-slate-400 mb-1">模組名稱</p>
          <p class="font-mono text-sm text-white">adder_8bit</p>
        </div>
        <div class="p-3 bg-slate-800 rounded-lg">
          <p class="text-xs text-slate-400 mb-1">程式碼行數</p>
          <p class="font-mono text-sm text-white">18</p>
        </div>
        <div class="p-3 bg-slate-800 rounded-lg">
          <p class="text-xs text-slate-400 mb-1">品質分數</p>
          <p class="font-mono text-sm text-green-400">92%</p>
        </div>
      </div>
      <div class="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
        <p class="text-sm font-medium text-yellow-400 mb-1">Lint 警告 (1)</p>
        <ul class="text-xs text-yellow-300/80 space-y-0.5 font-mono">
          <li>%Warning-WIDTH: adder_8bit.v:12: Operator ASSIGNW expects 9 bits on ASSIGN</li>
        </ul>
      </div>
      <div>
        <p class="text-sm font-medium mb-2 text-white">產出程式碼</p>
        <div class="rounded-xl overflow-hidden border border-slate-700">
          <div class="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
            <div class="flex items-center gap-2">
              <div class="flex gap-1.5">
                <div class="w-3 h-3 rounded-full bg-red-500/60"></div>
                <div class="w-3 h-3 rounded-full bg-yellow-500/60"></div>
                <div class="w-3 h-3 rounded-full bg-green-500/60"></div>
              </div>
              <span class="text-xs text-slate-400 ml-2 font-mono">adder_8bit.v</span>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-400">
              <span class="px-2 py-1">Copy</span>
              <span class="px-2 py-1">Download .v</span>
            </div>
          </div>
          <pre class="p-4 overflow-x-auto text-sm font-mono bg-[#0d1117] text-slate-300 leading-relaxed"><code>${escaped}</code></pre>
        </div>
      </div>
    </div>
    <div class="flex gap-3">
      <a href="/verify" class="flex-1 bg-green-600 text-white px-6 py-3 rounded-md font-medium text-center">
        送至驗證龍驗證 →
      </a>
    </div>`;
}

function verifyResultHTML() {
  return `
    <div class="p-6 border border-slate-700 rounded-lg bg-slate-800/50">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-semibold">驗證結果</h2>
        <span class="text-xs text-green-400 flex items-center gap-1">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
          已儲存至歷史紀錄
        </span>
      </div>
      <div class="grid md:grid-cols-3 gap-4 mb-6">
        <div class="p-3 bg-slate-800 rounded-lg">
          <p class="text-xs text-slate-400 mb-1">通過測試</p>
          <p class="text-2xl font-bold text-green-400">3</p>
        </div>
        <div class="p-3 bg-slate-800 rounded-lg">
          <p class="text-xs text-slate-400 mb-1">失敗測試</p>
          <p class="text-2xl font-bold text-red-400">0</p>
        </div>
        <div class="p-3 bg-slate-800 rounded-lg">
          <p class="text-xs text-slate-400 mb-1">程式碼覆蓋率</p>
          <p class="text-2xl font-bold text-white">94.2%</p>
        </div>
      </div>
      <div class="mb-6">
        <div class="flex items-center justify-between mb-2">
          <p class="text-sm font-medium text-white">驗證狀態</p>
          <span class="px-3 py-1 bg-green-500/10 text-green-400 rounded-full text-sm font-medium border border-green-500/30">
            全部通過
          </span>
        </div>
      </div>
      <div class="space-y-2 text-sm text-slate-400">
        <p>Testbench: <span class="font-mono text-xs text-slate-300">/sandbox/adder_8bit_tb.v</span></p>
        <p>Waveform: <span class="font-mono text-xs text-slate-300">/sandbox/adder_8bit.vcd</span></p>
      </div>
    </div>`;
}

async function main() {
  const browser = await chromium.launch();

  // ── Screenshot 1: Homepage ──
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '01-homepage.png') });
    console.log('Done: 01-homepage.png');
    await page.close();
  }

  // ── Screenshot 2: Design Dragon — focused on result ──
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto('http://localhost:3000/design', { waitUntil: 'networkidle' });

    // Click quick start to fill form
    await page.click('button:has-text("8-bit Adder")');
    await page.waitForTimeout(300);

    // Inject result section (all content is hardcoded demo data)
    const resultMarkup = designResultHTML(VERILOG_CODE);
    await page.evaluate((markup) => {
      const container = document.querySelector('.max-w-4xl');
      const wrapper = document.createElement('div');
      wrapper.className = 'mt-8 space-y-6';
      wrapper.innerHTML = markup; // eslint-disable-line -- hardcoded demo content
      container.appendChild(wrapper);
    }, resultMarkup);

    await page.waitForTimeout(300);

    // Scroll to show result section
    await page.evaluate(() => {
      const el = document.querySelector('.mt-8.space-y-6');
      if (el) el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -40);
    });

    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '02-design-result.png') });
    console.log('Done: 02-design-result.png');
    await page.close();
  }

  // ── Screenshot 3: Verification Dragon — focused on result ──
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto('http://localhost:3000/verify', { waitUntil: 'networkidle' });

    // Fill form
    await page.fill('input[type="text"]', 'adder_8bit');
    await page.fill('textarea', VERILOG_CODE);
    await page.waitForTimeout(200);

    // Inject result section
    const resultMarkup = verifyResultHTML();
    await page.evaluate((markup) => {
      const container = document.querySelector('.max-w-4xl');
      const wrapper = document.createElement('div');
      wrapper.className = 'mt-8 space-y-6';
      wrapper.innerHTML = markup; // eslint-disable-line -- hardcoded demo content
      container.appendChild(wrapper);
    }, resultMarkup);

    await page.waitForTimeout(300);

    // Scroll to show result
    await page.evaluate(() => {
      const el = document.querySelector('.mt-8.space-y-6');
      if (el) el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -40);
    });

    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '03-verify-result.png') });
    console.log('Done: 03-verify-result.png');
    await page.close();
  }

  // ── Screenshot 4: History with actual entries ──
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

    // Pre-populate localStorage
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
    await page.evaluate((vCode) => {
      const now = Date.now();
      const entries = [
        {
          id: 'h1', workspaceId: 'default', type: 'design',
          timestamp: now - 300000, moduleName: 'adder_8bit',
          description: '8-bit ripple carry adder with overflow detection',
          targetFreq: '100 MHz', code: vCode,
          qualityScore: 0.92, linesOfCode: 18,
          lintWarnings: ['%Warning-WIDTH: adder_8bit.v:12: Operator ASSIGNW expects 9 bits'],
        },
        {
          id: 'h2', workspaceId: 'default', type: 'verification',
          timestamp: now - 120000, moduleName: 'adder_8bit',
          code: vCode, testCasesPassed: 3, testCasesFailed: 0,
          codeCoverage: 0.942, errors: [],
        },
        {
          id: 'h3', workspaceId: 'default', type: 'design',
          timestamp: now - 600000, moduleName: 'counter_4bit',
          description: '4-bit synchronous up/down counter with reset and enable',
          targetFreq: '200 MHz',
          code: 'module counter_4bit(input clk, rst, en, ud, output reg [3:0] count);\nalways @(posedge clk or posedge rst)\n  if (rst) count <= 0;\n  else if (en) count <= ud ? count + 1 : count - 1;\nendmodule',
          qualityScore: 0.88, linesOfCode: 12, lintWarnings: [],
        },
        {
          id: 'h4', workspaceId: 'default', type: 'verification',
          timestamp: now - 500000, moduleName: 'counter_4bit',
          code: 'module counter_4bit_tb; ...',
          testCasesPassed: 5, testCasesFailed: 1,
          codeCoverage: 0.78,
          errors: ['ASSERTION FAILED: count mismatch at t=150ns, expected 4d0, got 4d15'],
        },
      ];
      localStorage.setItem('xylon-history', JSON.stringify(entries));
    }, VERILOG_CODE);

    // Navigate to history page
    await page.goto('http://localhost:3000/history', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Click to expand the first entry
    const firstEntry = await page.$('.cursor-pointer');
    if (firstEntry) {
      await firstEntry.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: path.join(OUT, '04-history.png') });
    console.log('Done: 04-history.png');
    await page.close();
  }

  await browser.close();
  console.log('\nAll demo screenshots captured!');
}

main().catch(console.error);
