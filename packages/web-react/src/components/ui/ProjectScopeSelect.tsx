import { useProjectScope } from "../../hooks/useProjectScope";
import { Select } from "./Select";

export function ProjectScopeSelect({
  id,
  className,
  disabled,
}: {
  id?: string;
  className?: string;
  disabled?: boolean;
}) {
  const { token, setToken, selectOptions, loading } = useProjectScope();
  return (
    <Select
      id={id}
      aria-label="项目范围"
      data-testid="project-scope-select"
      value={token}
      onValueChange={(v) => setToken(v as typeof token)}
      options={selectOptions}
      inputSize="sm"
      disabled={disabled || loading}
      className={className ?? "w-56"}
    />
  );
}
