export const ratios = ["4:3", "1:1", "3:4"] as const;
export type Ratio = (typeof ratios)[number];

export interface ImageNode {
  id: string;
  source: string | null;
  title: string;
  prompt: string;
  ratio: Ratio;
  artwork: number;
  x: number;
  y: number;
}

export const NODE_WIDTH = 288;
export const NODE_HEIGHT = 312;
export const MAX_NODES = 12;

export const initialNodes: readonly ImageNode[] = [
  {
    id: "A",
    source: null,
    title: "山间来信",
    prompt: "山间的极简建筑，晨光穿过拱门。",
    ratio: "4:3",
    artwork: 0,
    x: 0,
    y: 184,
  },
  {
    id: "B",
    source: "A",
    title: "让月光住进来",
    prompt: "保留建筑结构，将晨光改成蓝色月夜。",
    ratio: "4:3",
    artwork: 1,
    x: 360,
    y: 0,
  },
  {
    id: "C",
    source: "A",
    title: "另一种清晨",
    prompt: "将群山改为薄雾森林，柔化光影。",
    ratio: "4:3",
    artwork: 2,
    x: 320,
    y: 404,
  },
];

const palettes = [
  ["#eadac5", "#e6c09c", "#ad7d6b", "#7b706b", "#f6ead4", "#805846", "#53685f"],
  ["#223950", "#355674", "#243e51", "#14293c", "#c8d6d5", "#1b4045", "#687c89"],
  ["#dfe4d4", "#c8d7c1", "#7d9b89", "#5b786f", "#f3eddb", "#446a58", "#758779"],
] as const;

const viewBoxes = { "4:3": "0 0 640 480", "1:1": "80 0 480 480", "3:4": "140 0 360 480" };

export function FixtureArtwork({ node, className }: { node: ImageNode; className: string }) {
  const [sky, ground, ridge, foothills, light, shade, leaves] =
    palettes[node.artwork % palettes.length] ?? palettes[0];
  return (
    <svg
      className={className}
      viewBox={viewBoxes[node.ratio]}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect width="640" height="480" fill={sky} />
      <circle cx="470" cy="104" r="42" fill={light} />
      <path d="M0 265 121 95 274 283 387 164 640 310v170H0Z" fill={ridge} />
      <path d="M0 320 155 211 290 340 479 176 640 292v188H0Z" fill={foothills} />
      <path d="M0 379 209 306 640 361v119H0Z" fill={ground} />
      <path d="M199 179h244v211H199Z" fill={light} />
      <path d="m443 179 53 30v181h-53Z" fill={ground} />
      <path d="M266 390V280a54 54 0 0 1 108 0v110Z" fill={shade} />
      <path d="M280 390V282a40 40 0 0 1 80 0v108Z" fill={sky} />
      <path d="M199 390h297v13H186Zm-13 13h323v13H171Z" fill={light} />
      <path
        d="M95 300c-40-6-52-48-38-74 34 9 50 40 38 74m3-13c-3-45 19-69 46-70 8 34-8 60-46 70"
        fill={leaves}
        stroke={leaves}
        strokeWidth="4"
      />
      <ellipse cx="97" cy="388" rx="34" ry="7" fill={shade} />
      {node.artwork % palettes.length === 1 ? (
        <g fill={light}>
          <circle cx="120" cy="80" r="2" />
          <circle cx="324" cy="52" r="2" />
          <circle cx="540" cy="190" r="1.5" />
          <circle cx="392" cy="110" r="1.5" />
        </g>
      ) : null}
    </svg>
  );
}
