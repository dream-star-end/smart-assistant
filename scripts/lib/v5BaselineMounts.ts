export const CCB_BASELINE_TARGETS = [
  "/opt/openclaude/AGENTS.md",
  "/run/oc/claude-config/CLAUDE.md",
  "/run/oc/claude-config/skills",
] as const;

export interface MountLike {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}

export interface BaselineMountClassification {
  complete: boolean;
  missing: string[];
}


export type BaselineSourceSet = Readonly<Record<string, string>>;
export type BaselineSourceVariants = BaselineSourceSet | readonly BaselineSourceSet[];

/** Accept one complete trusted source triple. Variants are evaluated as
 * whole maps so a mixed standard/admin pair never passes accidentally. */
export function hasCompleteBaselineMounts(
  mounts: readonly MountLike[] | undefined,
  expected: BaselineSourceVariants,
): boolean {
  const variants: readonly BaselineSourceSet[] = Array.isArray(expected)
    ? expected
    : [expected as BaselineSourceSet];
  return variants.some((sources) => classifyBaselineMounts(mounts, sources).complete);
}

export function classifyBaselineMounts(
  mounts: readonly MountLike[] | undefined,
  expectedSources: Readonly<Record<string, string>>,
): BaselineMountClassification {
  const missing: string[] = [];
  for (const destination of CCB_BASELINE_TARGETS) {
    const matches = (mounts ?? []).filter((mount) => mount.Destination === destination);
    if (
      matches.length !== 1
      || matches[0]!.Type !== "bind"
      || matches[0]!.RW !== false
      || matches[0]!.Source !== expectedSources[destination]
    ) {
      missing.push(destination);
    }
  }
  return { complete: missing.length === 0, missing };
}
