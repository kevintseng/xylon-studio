import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";

const DARK = "#0f172a";
const ACCENT = "#3b82f6";
const CYAN = "#22d3ee";

const FadeIn: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });
  return <div style={{ opacity }}>{children}</div>;
};

const SlideUp: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - delay, fps, config: { damping: 20 } });
  const translateY = interpolate(progress, [0, 1], [60, 0]);
  const opacity = interpolate(progress, [0, 1], [0, 1]);
  return (
    <div style={{ transform: `translateY(${translateY}px)`, opacity }}>
      {children}
    </div>
  );
};

// X Logo SVG component
const XylonLogo: React.FC<{ size?: number }> = ({ size = 120 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 512 512"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id="xg1" x1="64" y1="64" x2="448" y2="448" gradientUnits="userSpaceOnUse">
        <stop stopColor="#3b82f6" />
        <stop offset="1" stopColor="#06b6d4" />
      </linearGradient>
      <linearGradient id="xg2" x1="448" y1="64" x2="64" y2="448" gradientUnits="userSpaceOnUse">
        <stop stopColor="#2563eb" />
        <stop offset="1" stopColor="#0891b2" />
      </linearGradient>
    </defs>
    <rect x="32" y="32" width="448" height="448" rx="96" fill={DARK} />
    <path d="M 148 148 L 364 364" stroke="url(#xg1)" strokeWidth="72" strokeLinecap="round" />
    <path d="M 364 148 L 148 364" stroke="url(#xg2)" strokeWidth="72" strokeLinecap="round" />
    <circle cx="256" cy="256" r="18" fill="white" opacity="0.15" />
  </svg>
);

// Scene 1: Title with Dragon Logo
const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 15 } });
  const subtitleOpacity = interpolate(frame, [20, 40], [0, 1], {
    extrapolateRight: "clamp",
  });
  const logoRotate = interpolate(frame, [0, 90], [0, 5], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${DARK} 0%, #1e293b 50%, #0f172a 100%)`,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <div style={{ transform: `rotate(${logoRotate}deg)`, marginBottom: 24 }}>
          <XylonLogo size={140} />
        </div>
        <h1
          style={{
            fontSize: 90,
            fontWeight: 800,
            color: "white",
            fontFamily: "system-ui, -apple-system, sans-serif",
            margin: 0,
            letterSpacing: -2,
          }}
        >
          Xylon<span style={{ color: ACCENT }}>Studio</span>
        </h1>
        <div style={{ opacity: subtitleOpacity, marginTop: 20 }}>
          <p
            style={{
              fontSize: 32,
              color: "#94a3b8",
              fontFamily: "system-ui, sans-serif",
              margin: 0,
            }}
          >
            AI-Driven Chip Design Platform
          </p>
          <p
            style={{
              fontSize: 22,
              color: "#64748b",
              fontFamily: "system-ui, sans-serif",
              marginTop: 16,
            }}
          >
            Natural Language → Production-Ready Verilog RTL
          </p>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene: Screenshot with label
const ScreenshotScene: React.FC<{
  src: string;
  label: string;
  sublabel?: string;
}> = ({ src, label, sublabel }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const imgScale = spring({ frame, fps, config: { damping: 20 } });
  const scale = interpolate(imgScale, [0, 1], [0.9, 1]);
  return (
    <AbsoluteFill
      style={{
        background: DARK,
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      <SlideUp>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h2
            style={{
              fontSize: 42,
              fontWeight: 700,
              color: "white",
              fontFamily: "system-ui, sans-serif",
              margin: 0,
            }}
          >
            {label}
          </h2>
          {sublabel && (
            <p
              style={{
                fontSize: 22,
                color: "#94a3b8",
                fontFamily: "system-ui, sans-serif",
                marginTop: 8,
              }}
            >
              {sublabel}
            </p>
          )}
        </div>
      </SlideUp>
      <div
        style={{
          transform: `scale(${scale})`,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
          maxWidth: 1600,
          maxHeight: 800,
        }}
      >
        <Img src={staticFile(src)} style={{ width: "100%", height: "auto" }} />
      </div>
    </AbsoluteFill>
  );
};

// Scene: Feature highlight
const FeatureScene: React.FC<{
  title: string;
  features: string[];
}> = ({ title, features }) => {
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${DARK} 0%, #1e293b 100%)`,
        justifyContent: "center",
        alignItems: "center",
        padding: 80,
      }}
    >
      <FadeIn>
        <div style={{ textAlign: "center" }}>
          <h2
            style={{
              fontSize: 52,
              fontWeight: 700,
              color: "white",
              fontFamily: "system-ui, sans-serif",
              marginBottom: 40,
            }}
          >
            {title}
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {features.map((f, i) => (
              <SlideUp key={i} delay={i * 8}>
                <div
                  style={{
                    fontSize: 28,
                    color: "#cbd5e1",
                    fontFamily: "system-ui, sans-serif",
                    background: "rgba(255,255,255,0.05)",
                    padding: "16px 32px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.1)",
                  }}
                >
                  {f}
                </div>
              </SlideUp>
            ))}
          </div>
        </div>
      </FadeIn>
    </AbsoluteFill>
  );
};

// Scene: Ending
const EndingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 15 } });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${DARK} 0%, #1e293b 50%, #0f172a 100%)`,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <XylonLogo size={100} />
        <h1
          style={{
            fontSize: 72,
            fontWeight: 800,
            color: "white",
            fontFamily: "system-ui, sans-serif",
            margin: "16px 0 0",
          }}
        >
          Xylon<span style={{ color: ACCENT }}>Studio</span>
        </h1>
        <p
          style={{
            fontSize: 28,
            color: "#94a3b8",
            fontFamily: "system-ui, sans-serif",
            marginTop: 20,
          }}
        >
          Open Source · MIT License
        </p>
        <p
          style={{
            fontSize: 24,
            color: ACCENT,
            fontFamily: "monospace",
            marginTop: 24,
          }}
        >
          github.com/kevintseng/xylon-studio
        </p>
      </div>
    </AbsoluteFill>
  );
};

// Main composition — 20s total (600 frames @ 30fps)
export const XylonStudioDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: DARK }}>
      {/* Scene 1: Title + Dragon Logo (0-3s) */}
      <Sequence from={0} durationInFrames={90}>
        <TitleScene />
      </Sequence>

      {/* Scene 2: Homepage with i18n (3-6s) */}
      <Sequence from={90} durationInFrames={90}>
        <ScreenshotScene
          src="01-homepage.png"
          label="首頁 — Homepage"
          sublabel="Animated circuit background · i18n 繁中/英文"
        />
      </Sequence>

      {/* Scene 3: Design Dragon (6-9s) */}
      <Sequence from={180} durationInFrames={90}>
        <ScreenshotScene
          src="02-design-result.png"
          label="設計龍 — Design Dragon"
          sublabel="Natural language → synthesizable Verilog RTL"
        />
      </Sequence>

      {/* Scene 4: Verification Dragon (9-12s) */}
      <Sequence from={270} durationInFrames={90}>
        <ScreenshotScene
          src="03-verify-result.png"
          label="驗證龍 — Verification Dragon"
          sublabel="Auto-generate testbenches · Verilator simulation"
        />
      </Sequence>

      {/* Scene 5: History & Workspace (12-15s) */}
      <Sequence from={360} durationInFrames={90}>
        <ScreenshotScene
          src="04-history.png"
          label="歷史紀錄 — History & Workspace"
          sublabel="Version management · project organization"
        />
      </Sequence>

      {/* Scene 6: Platform Features (15-18s) */}
      <Sequence from={450} durationInFrames={90}>
        <FeatureScene
          title="Platform Highlights"
          features={[
            "Self-hosted LLM — full data sovereignty",
            "Verilator lint & simulation in Docker sandbox",
            "Workspace & version history management",
            "i18n: English · 繁體中文",
          ]}
        />
      </Sequence>

      {/* Scene 7: Ending (18-20s) */}
      <Sequence from={540} durationInFrames={60}>
        <EndingScene />
      </Sequence>
    </AbsoluteFill>
  );
};
