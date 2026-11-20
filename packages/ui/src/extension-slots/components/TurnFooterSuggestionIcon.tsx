import {
  CompassIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  ListChecksIcon,
  PencilLineIcon,
  PenLineIcon,
  SearchIcon,
  TelescopeIcon,
  type LucideIcon,
} from "lucide-react";

const DIMENSION_ICONS: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/test|validat|verif|review|check|harden|测试|验证|评审|检查|校验|加固/iu, FlaskConicalIcon],
  [/rewrit|revis|edit|refin|improv|polish|修改|改写|润色|优化|重述/iu, PencilLineIcon],
  [/writ|creat|story|draft|compos|写作|创作|故事|起草|续写/iu, PenLineIcon],
  [/deep|detail|research|深化|深入|深挖|细化|研究/iu, TelescopeIcon],
  [/extend|expand|explor|branch|alternat|扩展|拓展|探索|分支|替代/iu, GitBranchIcon],
  [/implement|execut|plan|build|action|实施|执行|落地|计划|构建|行动/iu, ListChecksIcon],
  [/analy|explain|compar|summar|understand|分析|解释|对比|总结|理解/iu, SearchIcon],
];

/** 图标仅由宿主固定映射；插件维度不会被解释成 SVG、组件名或样式。 */
export function TurnFooterSuggestionIcon({ dimension }: { dimension: string }) {
  const Icon =
    DIMENSION_ICONS.find(([pattern]) => pattern.test(dimension.trim()))?.[1] ?? CompassIcon;
  return (
    <Icon
      aria-hidden="true"
      data-testid="turn-footer-suggestion-icon"
      className="mt-0.5 size-3.5 shrink-0 text-foreground-subtlest transition-colors duration-150 group-hover/nextstep:text-foreground group-focus-visible/nextstep:text-foreground motion-reduce:transition-none"
    />
  );
}
