import type { CanvasNode, Locale } from "./types.js";

/** 明暗两套 fixture 调色板：插图是本地 SVG 夹具，不是任何供应商的生成结果。 */
const PALETTES: readonly (readonly string[])[] = [
  ["#eadac5", "#e6c09c", "#ad7d6b", "#7b706b", "#f6ead4", "#805846", "#53685f"],
  ["#1c304a", "#355674", "#243e51", "#14293c", "#c8d6d5", "#1b4045", "#687c89"],
  ["#dfe4d4", "#c8d7c1", "#7d9b89", "#5b786f", "#f3eddb", "#446a58", "#758779"],
];

const VIEWBOX_BY_RATIO = {
  "4:3": "0 0 640 480",
  "1:1": "80 0 480 480",
  "3:4": "140 0 360 480",
} as const;

const ALT_BY_ART = ["晨光山间建筑插图", "月夜山间建筑插图", "薄雾森林建筑插图"] as const;

export interface IllustrationProps {
  art: number;
  ratio: CanvasNode["ratio"];
  title: string;
  className?: string;
}

/**
 * 离线 SVG 插图：由节点 art 序号确定性生成，无网络、无光栅资源。
 * 结构（天空、山峦、建筑、植被）用参数化路径绘制，避免复制旧实现的字符串拼接 HTML。
 */
export function Illustration({ art, ratio, title, className }: IllustrationProps) {
  const p = PALETTES[art % PALETTES.length] ?? PALETTES[0]!;
  const night = art % PALETTES.length === 1;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={VIEWBOX_BY_RATIO[ratio]}
      className={className}
      role="img"
      aria-label={`${ALT_BY_ART[art % ALT_BY_ART.length] ?? ALT_BY_ART[0]!}：${title}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect x="0" y="0" width="640" height="480" fill={p[0]} />
      <rect x="0" y="0" width="640" height="480" fill={night ? p[1] : "none"} opacity={night ? 0.35 : 0} />
      <circle cx="470" cy="104" r="42" fill={p[4]} />
      {/* 山峦：三层递进的折线带。 */}
      <path d="M0 265 121 95 274 283 387 164 640 310v170H0Z" fill={p[2]} />
      <path d="M0 320 155 211 290 340 479 176 640 292v188H0Z" fill={p[3]} />
      <path d="M0 379 209 306 640 361v119H0Z" fill={p[1]} />
      {/* 主体建筑：拱门 + 侧翼。 */}
      <path d="M199 179h244v211H199Z" fill={p[4]} />
      <path d="m443 179 53 30v181h-53Z" fill={p[1]} />
      <path d="M266 390V280a54 54 0 0 1 108 0v110Z" fill={p[5]} />
      <path d="M280 390V282a40 40 0 0 1 80 0v108Z" fill={p[0]} />
      <path d="M199 390h297v13H186Zm-13 13h323v13H171Z" fill={p[4]} />
      {/* 近景树。 */}
      <path
        d="M95 300c-40-6-52-48-38-74 34 9 50 40 38 74m3-13c-3-45 19-69 46-70 8 34-8 60-46 70"
        fill={p[6]}
        stroke={p[6]}
        strokeWidth="4"
      />
      <ellipse cx="97" cy="388" rx="34" ry="7" fill={p[5]} />
      {night ? (
        <g fill={p[4]}>
          <circle cx="120" cy="80" r="2" />
          <circle cx="324" cy="52" r="2" />
          <circle cx="540" cy="190" r="1.5" />
          <circle cx="392" cy="110" r="1.5" />
        </g>
      ) : null}
    </svg>
  );
}

export const INITIAL_NODES: readonly CanvasNode[] = [
  {
    id: "A",
    title: "山间来信",
    prompt: "山间的极简建筑，晨光穿过拱门，柔和的胶片质感。",
    source: null,
    x: 0,
    y: 180,
    art: 0,
    ratio: "4:3",
    time: "初始夹具",
  },
  {
    id: "B",
    title: "让月光住进来",
    prompt: "保留建筑结构，将晨光改为安静的蓝色月夜。",
    source: "A",
    x: 440,
    y: 0,
    art: 1,
    ratio: "4:3",
    time: "初始夹具",
  },
  {
    id: "C",
    title: "另一种清晨",
    prompt: "将群山变为薄雾森林，柔化光影，增加一抹绿色。",
    source: "A",
    x: 440,
    y: 420,
    art: 2,
    ratio: "4:3",
    time: "初始夹具",
  },
] as const;

export function fixtureTimeLabel(locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date());
}
