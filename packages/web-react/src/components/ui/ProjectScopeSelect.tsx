import { useProjectScope } from "../../hooks/useProjectScope";
import { Select } from "./Select";

export function ProjectScopeSelect({
  id,
  className,
  disabled,
  variant = "full",
}: {
  id?: string;
  className?: string;
  disabled?: boolean;
  /** Taskboard/Cost/Weekly: work/all/none only — never unbound chat ids. */
  variant?: "full" | "work";
}) {
  const { token, setToken, selectOptions, workProjects, loading } = useProjectScope();
  const options =
    variant === "work"
      ? selectOptions.filter(
          (o) => o.value === "all" || o.value === "none" || workProjects.some((w) => w.id === o.value),
        )
      : selectOptions;
  const value = options.some((o) => o.value === token) ? token : "all";
  return (
    <Select
      id={id}
      aria-label="项目范围"
      data-testid={variant === "work" ? "project-scope-select-work" : "project-scope-select"}
      value={value}
      onValueChange={(v) => setToken(v as typeof token)}
      options={options}
      inputSize="sm"
      disabled={disabled || loading}
      className={className ?? "w-56"}
    />
  );
}
