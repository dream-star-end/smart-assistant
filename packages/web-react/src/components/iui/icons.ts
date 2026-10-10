/**
 * Intelligent UI 图标表。
 *
 * 图标形状(lucide 的 IconNode)放在 iconNodes.generated.ts,跟着懒加载的组件块走,用 lucide 的通用
 * <Icon iconNode> 画。这里不直接 import lucide-react 的图标组件:vite 把所有 lucide-react 模块归进首屏
 * 的 lucide-vendor 块,下面八十多个只有组件里才用的图标会占掉约 6KB 首屏预算(见 vite.config.ts)。
 *
 * 改了名单之后运行 `node scripts/gen-iui-icons.mjs` 重新生成形状数据;icons.test.ts 核对数据与
 * 已安装的 lucide-react 一致,升级 lucide 后跑一次生成即可。
 */
import type { IconNode } from "lucide-react";
import { ICON_NODES } from "./iconNodes.generated";

type LucideName = keyof typeof ICON_NODES;

/** 模型可用的图标名(写进提示词)→ lucide 图标名。 */
export const ICON_SOURCES = {
  leaf: "leaf",
  sprout: "sprout",
  flower: "flower-2",
  tree: "tree-pine",
  carrot: "carrot",
  apple: "apple",
  salad: "salad",
  soup: "soup",
  beef: "beef",
  fish: "fish",
  pizza: "pizza",
  cake: "cake-slice",
  coffee: "coffee",
  wine: "wine",
  utensils: "utensils",
  chef: "chef-hat",
  home: "house",
  bed: "bed",
  sofa: "sofa",
  bath: "bath",
  building: "building-2",
  store: "store",
  hotel: "hotel",
  landmark: "landmark",
  plane: "plane",
  car: "car",
  train: "train-front",
  bike: "bike",
  ship: "ship",
  pin: "map-pin",
  mountain: "mountain",
  tent: "tent",
  walk: "footprints",
  globe: "globe",
  sun: "sun",
  moon: "moon",
  cloud: "cloud",
  snow: "snowflake",
  water: "droplet",
  fire: "flame",
  energy: "zap",
  wind: "wind",
  heart: "heart",
  star: "star",
  gift: "gift",
  book: "book-open",
  study: "graduation-cap",
  brain: "brain",
  work: "briefcase",
  fitness: "dumbbell",
  health: "stethoscope",
  pill: "pill",
  music: "music",
  camera: "camera",
  game: "gamepad-2",
  shirt: "shirt",
  gem: "gem",
  paint: "paintbrush",
  scissors: "scissors",
  tool: "wrench",
  hammer: "hammer",
  money: "wallet",
  savings: "piggy-bank",
  shopping: "shopping-bag",
  package: "package",
  truck: "truck",
  calendar: "calendar",
  clock: "clock",
  shield: "shield",
  idea: "lightbulb",
  target: "target",
  trophy: "trophy",
  rocket: "rocket",
  sparkles: "sparkles",
  user: "user",
  people: "users",
  baby: "baby",
  dog: "dog",
  cat: "cat",
  phone: "smartphone",
  laptop: "laptop",
} as const satisfies Record<string, LucideName>;

/** 组件标题前的类型徽章。 */
export const KIND_ICON_SOURCES = {
  table: "table-2",
  chart: "chart-column",
  stats: "gauge",
  steps: "list-checks",
  compare: "columns-3",
  calculator: "calculator",
  tabs: "panels-top-left",
  timeline: "calendar-clock",
  cards: "layout-list",
  gallery: "images",
  swatches: "palette",
  tiles: "layout-grid",
  recipe: "chef-hat",
  quiz: "graduation-cap",
  progress: "chart-bar-big",
  kv: "list-tree",
  form: "clipboard-list",
  route: "route",
  sources: "book-marked",
  outline: "network",
  draft: "pen-line",
} as const satisfies Record<string, LucideName>;

/** 组件内部控件用、别处没有引过的图标(同样走生成的形状数据,不进首屏)。 */
export const UI_ICON_SOURCES = {
  diff: "git-compare-arrows",
} as const satisfies Record<string, LucideName>;

export const ICON_NAMES = Object.keys(ICON_SOURCES);

const lookup = (sources: Record<string, LucideName>, key: string): IconNode | null => {
  const name = Object.hasOwn(sources, key) ? sources[key] : undefined;
  return name ? ICON_NODES[name] : null;
};

/** 模型写的图标名 → 形状;未知名字返回 null(调用方用首字代替)。也认 "map-pin" 这类首段。 */
export function iconFor(name: string | undefined): IconNode | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return lookup(ICON_SOURCES, n.replace(/[\s_]+/g, "-")) ?? lookup(ICON_SOURCES, n.split(/[-\s_]/)[0]!);
}

export function kindIcon(kind: string): IconNode | null {
  return lookup(KIND_ICON_SOURCES, kind);
}

export function uiIcon(name: keyof typeof UI_ICON_SOURCES): IconNode {
  return ICON_NODES[UI_ICON_SOURCES[name]];
}
