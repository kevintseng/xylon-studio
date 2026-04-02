'use client'

import { CircuitBackground } from '@/components/circuit-bg'
import { useI18n } from '@/lib/i18n'

export default function Home() {
  const { t } = useI18n()

  return (
    <div className="relative min-h-[calc(100vh-130px)] flex items-center">
      <CircuitBackground />
      {/* Gradient overlays */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-blue-600/5 blur-3xl" />
        <div className="absolute -bottom-20 -left-20 w-80 h-80 rounded-full bg-blue-500/5 blur-3xl" />
      </div>

      <div className="container mx-auto px-8 py-16 grid lg:grid-cols-2 gap-16 items-center">
        {/* Left: Brand text */}
        <div className="space-y-8">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-full text-xs font-medium text-blue-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            {t('home.badge')}
          </div>

          <h1 className="text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
            {t('home.title1')}
            <br />
            <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
              {t('home.title2')}
            </span>
          </h1>

          <p className="text-lg text-slate-400 leading-relaxed max-w-lg">
            {t('home.description')}
          </p>

          <div className="flex gap-4">
            <a
              href="/design"
              className="px-6 py-3 rounded-lg font-semibold text-sm bg-blue-600 text-white hover:bg-blue-500 active:scale-[0.98] transition-all shadow-lg shadow-blue-600/25"
            >
              {t('home.cta.design')}
            </a>
            <a
              href="/verify"
              className="px-6 py-3 rounded-lg font-semibold text-sm bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 active:scale-[0.98] transition-all"
            >
              {t('home.cta.verify')}
            </a>
          </div>
        </div>

        {/* Right: Code preview */}
        <div className="hidden lg:block">
          <div className="rounded-xl border border-slate-700 overflow-hidden shadow-2xl shadow-black/40">
            <div className="bg-slate-800 px-4 py-3 flex items-center gap-2 border-b border-slate-700">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500/60" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                <div className="w-3 h-3 rounded-full bg-green-500/60" />
              </div>
              <span className="text-xs text-slate-400 ml-2 font-mono">
                barrel_shifter_16bit.v
              </span>
            </div>
            <pre className="p-6 text-xs font-mono bg-[#0d1117] text-slate-300 leading-relaxed overflow-hidden">
              <code>{`module barrel_shifter_16bit (
  input         clk,
  input         rst_n,
  input  [15:0] data_in,
  input  [3:0]  shift_amt,
  input         shift_dir,  // 0=left, 1=right
  output [15:0] data_out
);

  reg [15:0] stage1, stage2, result;

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      result <= 16'b0;
    else
      result <= stage2;
  end

  assign data_out = result;
endmodule`}</code>
            </pre>
          </div>
          <p className="text-xs text-slate-500 text-center mt-3">
            {t('home.code.caption')}
          </p>
        </div>
      </div>
    </div>
  )
}
