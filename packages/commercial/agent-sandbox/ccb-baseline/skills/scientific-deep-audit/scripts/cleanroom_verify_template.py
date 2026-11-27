#!/usr/bin/env python3
"""
Reusable cleanroom deterministic physics & code verification template (OCV5-895 / OCV5-900).

Core checks work out of the box on Python 3.11+ with numpy / scipy / sympy.
Optional scientific packages (`pint`, `uncertainties`, `hypothesis`, `z3`, `pytest`)
are probed gracefully: missing packages produce a structured SKIP rather than crashing,
and when installed they automatically unlock dimensional, uncertainty, property-based
differential fuzzing, and Z3 SMT inequality / counterexample checks.

Sub-checks:
  1. check_jacobian_parity   - Central / complex-step finite diff vs analytic Jacobian (<1e-8)
  2. check_so3_invariants    - Rotation matrix orthogonality (R^T R = I) and chirality (det(R) = +1)
  3. check_nonzero_roundtrip - Non-zero asymmetric large-parameter roundtrip fuzzing (f^-1(f(x)) ~ x)
  4. check_dimensions        - Physical equation dimensional consistency (via optional `pint`)
  5. check_ssot_numbers      - Markdown / report number reconciliation vs metrics.json / CSV + RMS-vs-var check
  6. check_callsite_impact   - Production callsite scan highlighting calls missing new gating/option args
  7. check_smt_inequality    - Safe AST-whitelisted Z3 SMT inequality proof, non-vacuity check & counterexample search

Usage:
  python3 cleanroom_verify_template.py --self-test
  python3 cleanroom_verify_template.py --mode ssot --doc report.md --ssot metrics.json
  python3 cleanroom_verify_template.py --mode callsite --root ./src --symbol polar_to_local --required-arg opt
  python3 cleanroom_verify_template.py --mode so3 --matrix '[[1,0,0],[0,1,0],[0,0,1]]'
  python3 cleanroom_verify_template.py --mode dimensions --lhs 'm / s^2' --rhs 'N / kg'
  python3 cleanroom_verify_template.py --mode smt --vars '{"x":"real"}' --assume 'x > 0' --conclude 'x + 1/x >= 2'
"""

from __future__ import annotations

import argparse
import ast
import csv
import importlib
import json
import keyword
import math
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import numpy as np


# ---------------------------------------------------------------------------
# Optional dependency probing (graceful SKIP when absent)
# ---------------------------------------------------------------------------

def probe_optional_packages() -> dict[str, dict[str, Any]]:
    """Probe optional verification libraries without failing if absent."""
    probes: dict[str, dict[str, Any]] = {}
    for pkg in ("numpy", "scipy", "sympy", "pint", "uncertainties", "hypothesis", "z3", "pytest"):
        try:
            mod = importlib.import_module(pkg)
            version = getattr(mod, "__version__", None)
            if not version and hasattr(mod, "get_version_string"):
                version = mod.get_version_string()
            probes[pkg] = {
                "available": True,
                "version": version or "unknown",
            }
        except ImportError as exc:
            probes[pkg] = {
                "available": False,
                "version": None,
                "reason": str(exc),
            }
    return probes


@dataclass
class CheckResult:
    name: str
    status: str  # "PASS" | "FAIL" | "SKIP"
    summary: str
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# 1. Jacobian Parity: Central / Complex-Step Finite Diff vs Analytic Jacobian
# ---------------------------------------------------------------------------

def check_jacobian_parity(
    fn: Callable[[np.ndarray], np.ndarray],
    analytic_jac: Callable[[np.ndarray], np.ndarray],
    x0: Sequence[float] | np.ndarray,
    *,
    eps: float = 1e-6,
    tol: float = 1e-8,
    use_complex_step: bool = False,
    complex_step: float = 1e-20,
) -> CheckResult:
    """Compare an analytic Jacobian against central (or complex-step) finite differences."""
    x = np.asarray(x0, dtype=float).reshape(-1)
    if x.size == 0:
        return CheckResult("check_jacobian_parity", "FAIL", "x0 must be non-empty")

    j_ana = np.atleast_2d(np.asarray(analytic_jac(x), dtype=float))
    f0 = np.atleast_1d(np.asarray(fn(x), dtype=float)).reshape(-1)
    m, n = f0.size, x.size
    if j_ana.shape != (m, n):
        return CheckResult(
            "check_jacobian_parity",
            "FAIL",
            f"Analytic Jacobian shape {j_ana.shape} != expected ({m}, {n})",
        )

    j_num = np.zeros((m, n), dtype=float)
    if use_complex_step:
        xc = x.astype(np.complex128)
        for j in range(n):
            xp = xc.copy()
            xp[j] += 1j * complex_step
            fp = np.atleast_1d(np.asarray(fn(xp), dtype=np.complex128)).reshape(-1)
            j_num[:, j] = np.imag(fp) / complex_step
    else:
        for j in range(n):
            dx = np.zeros(n, dtype=float)
            h = eps * max(1.0, abs(float(x[j])))
            dx[j] = h
            fp = np.atleast_1d(np.asarray(fn(x + dx), dtype=float)).reshape(-1)
            fm = np.atleast_1d(np.asarray(fn(x - dx), dtype=float)).reshape(-1)
            j_num[:, j] = (fp - fm) / (2.0 * h)

    diff = np.abs(j_ana - j_num)
    max_abs_err = float(np.max(diff))
    denom = np.maximum(1.0, np.maximum(np.abs(j_ana), np.abs(j_num)))
    max_rel_err = float(np.max(diff / denom))
    worst_idx = tuple(int(i) for i in np.unravel_index(int(np.argmax(diff)), diff.shape))

    passed = math.isfinite(max_abs_err) and max_abs_err < tol
    return CheckResult(
        "check_jacobian_parity",
        "PASS" if passed else "FAIL",
        (
            f"max_abs_err={max_abs_err:.3e} (< tol={tol:.1e})"
            if passed
            else f"Jacobian mismatch: max_abs_err={max_abs_err:.3e} >= tol={tol:.1e} at {worst_idx}"
        ),
        {
            "method": "complex_step" if use_complex_step else "central_diff",
            "shape": [m, n],
            "max_abs_err": max_abs_err,
            "max_rel_err": max_rel_err,
            "worst_entry": list(worst_idx),
            "tol": tol,
        },
    )


# ---------------------------------------------------------------------------
# 2. SO(3) Invariants: Orthogonality R^T R = I and Chirality det(R) = +1
# ---------------------------------------------------------------------------

def check_so3_invariants(
    rotation: Sequence[Sequence[float]] | np.ndarray,
    *,
    tol: float = 1e-10,
) -> CheckResult:
    """Verify R in SO(3): R^T R = I and det(R) = +1 (rejects improper reflections)."""
    arr = np.asarray(rotation, dtype=float)
    if arr.ndim == 2:
        mats = arr[np.newaxis, :, :]
    elif arr.ndim == 3:
        mats = arr
    else:
        return CheckResult(
            "check_so3_invariants",
            "FAIL",
            f"Expected shape (3,3) or (N,3,3), got {arr.shape}",
        )

    if mats.shape[1:] != (3, 3):
        return CheckResult(
            "check_so3_invariants",
            "FAIL",
            f"Expected 3x3 matrices, got {mats.shape}",
        )

    if not np.all(np.isfinite(mats)):
        return CheckResult("check_so3_invariants", "FAIL", "Non-finite entries in rotation matrix")

    eye = np.eye(3, dtype=float)
    max_ortho_err = 0.0
    max_det_err = 0.0
    worst_det = 1.0
    for r in mats:
        ortho_err = float(np.max(np.abs(r.T @ r - eye)))
        det_val = float(np.linalg.det(r))
        det_err = abs(det_val - 1.0)
        if ortho_err > max_ortho_err:
            max_ortho_err = ortho_err
        if det_err > max_det_err:
            max_det_err = det_err
            worst_det = det_val

    passed = max_ortho_err < tol and max_det_err < tol
    return CheckResult(
        "check_so3_invariants",
        "PASS" if passed else "FAIL",
        (
            f"SO(3) verified ({mats.shape[0]} matrix/matrices): ortho_err={max_ortho_err:.3e}, det_err={max_det_err:.3e}"
            if passed
            else f"SO(3) violation: ortho_err={max_ortho_err:.3e}, det={worst_det:.6f} (det_err={max_det_err:.3e}, tol={tol:.1e})"
        ),
        {
            "count": int(mats.shape[0]),
            "max_ortho_err": max_ortho_err,
            "max_det_err": max_det_err,
            "worst_det": worst_det,
            "tol": tol,
        },
    )


# ---------------------------------------------------------------------------
# 3. Non-Zero Asymmetric Large-Parameter Differential Roundtrip Fuzzing
# ---------------------------------------------------------------------------

def check_nonzero_roundtrip(
    forward_fn: Callable[[np.ndarray], np.ndarray],
    inverse_fn: Callable[[np.ndarray], np.ndarray],
    dim: int,
    *,
    samples: int = 64,
    seed: int = 20261126,
    min_abs: float = 1.5,
    max_abs: float = 250.0,
    tol: float = 1e-8,
    baseline_output_fn: Callable[[np.ndarray], np.ndarray] | None = None,
) -> CheckResult:
    """
    Fuzz forward/inverse roundtrip with strictly non-zero, asymmetric, large-magnitude
    inputs so silent fallback to zero defaults or axis-swap bugs cannot hide.
    Automatically runs Hypothesis shrinking when `hypothesis` is installed.
    """
    if dim <= 0:
        return CheckResult("check_nonzero_roundtrip", "FAIL", f"dim must be > 0, got {dim}")

    rng = np.random.default_rng(seed)
    max_roundtrip_err = 0.0
    worst_sample: list[float] | None = None
    identical_to_baseline = 0

    def _draw_asymmetric_nonzero() -> np.ndarray:
        mags = rng.uniform(min_abs, max_abs, size=dim)
        # Enforce distinct component magnitudes to break accidental axis symmetry
        offsets = np.arange(dim, dtype=float) * 0.37
        signs = rng.choice([-1.0, 1.0], size=dim)
        return signs * (mags + offsets)

    for _ in range(samples):
        x = _draw_asymmetric_nonzero()
        y = np.asarray(forward_fn(x), dtype=float)
        x_rec = np.asarray(inverse_fn(y), dtype=float)
        if x_rec.shape != x.shape or not np.all(np.isfinite(x_rec)):
            return CheckResult(
                "check_nonzero_roundtrip",
                "FAIL",
                f"Shape/finiteness failure on non-zero input {x.tolist()}",
                {"input": x.tolist()},
            )
        err = float(np.max(np.abs(x_rec - x)))
        if err > max_roundtrip_err:
            max_roundtrip_err = err
            worst_sample = x.tolist()
        if baseline_output_fn is not None:
            y_base = np.asarray(baseline_output_fn(x), dtype=float)
            if y_base.shape == y.shape and np.allclose(y, y_base, atol=tol, rtol=0.0):
                identical_to_baseline += 1

    hypothesis_used = False
    hypothesis_error: str | None = None
    try:
        from hypothesis import given, settings, strategies as st  # type: ignore

        hypothesis_used = True

        @settings(max_examples=min(samples, 50), derandomize=True, database=None)
        @given(
            st.lists(
                st.floats(min_value=min_abs, max_value=max_abs, allow_nan=False, allow_infinity=False),
                min_size=dim,
                max_size=dim,
            ),
            st.lists(st.sampled_from([-1.0, 1.0]), min_size=dim, max_size=dim),
        )
        def _prop_roundtrip(mags: list[float], signs: list[float]) -> None:
            x_h = np.array([s * (m + i * 0.37) for i, (m, s) in enumerate(zip(mags, signs))], dtype=float)
            x_rec_h = np.asarray(inverse_fn(forward_fn(x_h)), dtype=float)
            assert np.all(np.isfinite(x_rec_h)), f"non-finite roundtrip for {x_h.tolist()}"
            err_h = float(np.max(np.abs(x_rec_h - x_h)))
            assert err_h < tol, f"roundtrip err={err_h:.3e} >= tol={tol:.1e} at x={x_h.tolist()}"

        try:
            _prop_roundtrip()
        except AssertionError as exc:
            hypothesis_error = str(exc)
    except ImportError:
        pass

    collapsed_to_baseline = baseline_output_fn is not None and identical_to_baseline == samples
    passed = (
        math.isfinite(max_roundtrip_err)
        and max_roundtrip_err < tol
        and not collapsed_to_baseline
        and hypothesis_error is None
    )

    reasons: list[str] = []
    if max_roundtrip_err >= tol or not math.isfinite(max_roundtrip_err):
        reasons.append(f"max_roundtrip_err={max_roundtrip_err:.3e} >= tol={tol:.1e}")
    if collapsed_to_baseline:
        reasons.append("outputs collapsed identically to legacy/baseline model on all non-zero inputs")
    if hypothesis_error is not None:
        reasons.append(f"hypothesis counterexample: {hypothesis_error}")

    return CheckResult(
        "check_nonzero_roundtrip",
        "PASS" if passed else "FAIL",
        (
            f"Non-zero roundtrip verified ({samples} samples, hypothesis={'on' if hypothesis_used else 'fallback'}): max_err={max_roundtrip_err:.3e}"
            if passed
            else "; ".join(reasons)
        ),
        {
            "samples": samples,
            "dim": dim,
            "min_abs": min_abs,
            "max_abs": max_abs,
            "max_roundtrip_err": max_roundtrip_err,
            "worst_sample": worst_sample,
            "identical_to_baseline": identical_to_baseline,
            "hypothesis_used": hypothesis_used,
            "hypothesis_error": hypothesis_error,
            "tol": tol,
        },
    )


# ---------------------------------------------------------------------------
# 4. Dimensional Consistency Check (via optional `pint`)
# ---------------------------------------------------------------------------

def check_dimensions(equations: Sequence[dict[str, str]]) -> CheckResult:
    """
    Verify dimensional equality for physical equations using `pint`.
    Each equation dict requires: {"name": str, "lhs": "<unit expr>", "rhs": "<unit expr>"}.
    Returns SKIP gracefully if `pint` is not installed.
    """
    try:
        import pint  # type: ignore
    except ImportError:
        return CheckResult(
            "check_dimensions",
            "SKIP",
            "pint not installed; skipping dimensional analysis (install pint==0.25.3 to enable)",
            {"equations_requested": len(equations)},
        )

    ureg = pint.UnitRegistry()
    mismatches: list[dict[str, str]] = []
    checked: list[dict[str, Any]] = []

    for idx, eq in enumerate(equations):
        name = eq.get("name", f"eq_{idx}")
        lhs_raw = eq["lhs"]
        rhs_raw = eq["rhs"]
        try:
            lhs_q = ureg.parse_expression(lhs_raw)
            rhs_q = ureg.parse_expression(rhs_raw)
            lhs_dim = str(lhs_q.dimensionality)
            rhs_dim = str(rhs_q.dimensionality)
            ok = lhs_q.dimensionality == rhs_q.dimensionality
            checked.append({"name": name, "lhs": lhs_raw, "rhs": rhs_raw, "ok": ok, "lhs_dim": lhs_dim, "rhs_dim": rhs_dim})
            if not ok:
                mismatches.append({"name": name, "lhs": lhs_raw, "rhs": rhs_raw, "lhs_dim": lhs_dim, "rhs_dim": rhs_dim})
        except Exception as exc:  # noqa: BLE001
            mismatches.append({"name": name, "lhs": lhs_raw, "rhs": rhs_raw, "error": str(exc)})

    passed = len(mismatches) == 0
    return CheckResult(
        "check_dimensions",
        "PASS" if passed else "FAIL",
        (
            f"All {len(checked)} equation(s) dimensionally consistent via pint"
            if passed
            else f"{len(mismatches)} dimensional mismatch(es) found"
        ),
        {"checked": checked, "mismatches": mismatches},
    )


# ---------------------------------------------------------------------------
# 5. SSOT Reconciliation: Markdown / Report vs metrics.json / CSV
# ---------------------------------------------------------------------------

def _flatten_json(obj: Any, prefix: str = "") -> dict[str, float]:
    out: dict[str, float] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            out.update(_flatten_json(v, key))
    elif isinstance(obj, list):
        for idx, v in enumerate(obj):
            out.update(_flatten_json(v, f"{prefix}[{idx}]"))
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool) and math.isfinite(float(obj)):
        out[prefix] = float(obj)
    return out


def _load_ssot_values(ssot_path: Path) -> dict[str, float]:
    suffix = ssot_path.suffix.lower()
    if suffix == ".json":
        data = json.loads(ssot_path.read_text(encoding="utf-8"))
        return _flatten_json(data)
    if suffix == ".csv":
        out: dict[str, float] = {}
        with ssot_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row_idx, row in enumerate(reader):
                row_key = row.get("metric") or row.get("name") or row.get("key") or f"row{row_idx}"
                for col, val in row.items():
                    if col in ("metric", "name", "key") or val is None:
                        continue
                    try:
                        num = float(val)
                    except ValueError:
                        continue
                    if math.isfinite(num):
                        full_key = f"{row_key}.{col}" if ("metric" in row or "name" in row or "key" in row) else f"{col}[{row_idx}]"
                        out[full_key] = num
                        if col in ("value", "val"):
                            out[str(row_key)] = num
        return out
    raise ValueError(f"Unsupported SSOT file type: {ssot_path.suffix} (expected .json or .csv)")


_NUM_PATTERN = r"([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)"
_ANNOTATED_SSOT_RE = re.compile(
    rf"<!--\s*ssot\s*:\s*([A-Za-z0-9_.\-\[\]]+)\s*-->(?:\s*{_NUM_PATTERN})?"
)
_TEMPLATE_SSOT_RE = re.compile(
    r"\{\{\s*(?:metrics\.|metric:)([A-Za-z0-9_.\-\[\]]+?)(?:\|[^}]*)?\s*\}\}"
)
_KV_SSOT_RE = re.compile(
    rf"(?:`|\b)([A-Za-z0-9_.\-]+)(?:`|\b)\s*(?:=|:)\s*{_NUM_PATTERN}"
)


def emit_witness_verdict(
    status: str,
    summary: str,
    metric: str = "",
    finding_digest: str = "",
) -> dict[str, Any]:
    """
    Emit a structured machine-witness verdict for `oc-review verify --exec`.
    Writes JSON to `OC_WITNESS_VERDICT_FILE` when set and prints the sentinel line
    `OC_WITNESS_VERDICT: <json>` to stdout. Witness scripts must exit 0.
    """
    if status not in ("confirmed", "refuted"):
        raise ValueError(f"Invalid witness verdict status {status!r}; expected 'confirmed' or 'refuted'")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("Witness verdict summary must be a non-empty string")

    payload: dict[str, Any] = {
        "status": status,
        "summary": summary.strip(),
    }
    if metric and metric.strip():
        payload["metric"] = metric.strip()
    digest = finding_digest.strip() if finding_digest else os.environ.get("OC_WITNESS_FINDING_DIGEST", "").strip()
    if digest:
        payload["finding_digest"] = digest

    verdict_file = os.environ.get("OC_WITNESS_VERDICT_FILE", "").strip()
    if verdict_file:
        out_path = Path(verdict_file)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    print(f"OC_WITNESS_VERDICT: {json.dumps(payload, ensure_ascii=False)}", flush=True)
    return payload


def check_ssot_numbers(
    doc_path: str | Path,
    ssot_path: str | Path,
    *,
    rel_tol: float = 1e-4,
    abs_tol: float = 1e-6,
) -> CheckResult:
    """
    Reconcile numeric claims in a Markdown/text report against metrics.json or CSV SSOT.
    Supports `<!-- ssot: key.path --> 1.234`, `{{metrics.key.path}}`, `key.path = 1.234`,
    and Markdown tables whose first column matches an SSOT key. Explicit SSOT keys that
    are missing from metrics.json/CSV are recorded in `missing_keys` and force FAIL.
    """
    doc_file = Path(doc_path)
    ssot_file = Path(ssot_path)
    ssot = _load_ssot_values(ssot_file)
    text = doc_file.read_text(encoding="utf-8")

    # Build unambiguous suffix lookup for leaf names when unique
    leaf_counts: dict[str, list[str]] = {}
    for k in ssot:
        leaf = k.split(".")[-1]
        leaf_counts.setdefault(leaf, []).append(k)

    def _resolve_key(candidate: str) -> str | None:
        if candidate in ssot:
            return candidate
        matches = leaf_counts.get(candidate)
        if matches and len(matches) == 1:
            return matches[0]
        return None

    claims: list[tuple[int, str, float, str]] = []
    missing_keys: list[str] = []
    missing_seen: set[str] = set()
    unresolved_templates: list[str] = []
    unchecked_explicit = 0

    def _record_missing(raw_key: str) -> None:
        if raw_key not in missing_seen:
            missing_seen.add(raw_key)
            missing_keys.append(raw_key)

    lines = text.splitlines()
    for lineno, line in enumerate(lines, start=1):
        for m in _ANNOTATED_SSOT_RE.finditer(line):
            raw_key = m.group(1)
            num_str = m.group(2)
            key = _resolve_key(raw_key)
            if num_str is not None:
                if key:
                    claims.append((lineno, key, float(num_str), line))
                else:
                    _record_missing(raw_key)
                    unchecked_explicit += 1
            else:
                if not key:
                    _record_missing(raw_key)
                unchecked_explicit += 1

        for m in _TEMPLATE_SSOT_RE.finditer(line):
            raw_key = m.group(1)
            unresolved_templates.append(m.group(0))
            if not _resolve_key(raw_key):
                _record_missing(raw_key)

        for m in _KV_SSOT_RE.finditer(line):
            key = _resolve_key(m.group(1))
            if key:
                claims.append((lineno, key, float(m.group(2)), line))

        if "|" in line:
            cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
            if len(cells) >= 2:
                key = _resolve_key(cells[0])
                if key:
                    for cell in cells[1:]:
                        num_m = re.fullmatch(_NUM_PATTERN, cell)
                        if num_m:
                            claims.append((lineno, key, float(num_m.group(1)), line))
                            break

    # Deduplicate same (lineno, key, value)
    seen_claims: set[tuple[int, str, float]] = set()
    drifts: list[dict[str, Any]] = []
    rms_var_warnings: list[dict[str, Any]] = []
    matched_count = 0

    for lineno, key, doc_val, line_text in claims:
        sig = (lineno, key, doc_val)
        if sig in seen_claims:
            continue
        seen_claims.add(sig)
        matched_count += 1
        ssot_val = ssot[key]
        abs_err = abs(doc_val - ssot_val)
        rel_err = abs_err / max(abs(ssot_val), 1e-12)
        if abs_err > abs_tol and rel_err > rel_tol:
            entry: dict[str, Any] = {
                "line": lineno,
                "key": key,
                "doc_value": doc_val,
                "ssot_value": ssot_val,
                "abs_err": abs_err,
                "rel_err": rel_err,
            }
            # Detect RMS vs variance confusion (x vs x^2 or sqrt(x))
            if ssot_val > 0 and abs(ssot_val - 1.0) > 1e-3 and doc_val > 0:
                sq_rel = abs(doc_val - ssot_val ** 2) / max(ssot_val ** 2, 1e-12)
                sqrt_rel = abs(doc_val - math.sqrt(ssot_val)) / max(math.sqrt(ssot_val), 1e-12)
                if sq_rel < 0.02 or sqrt_rel < 0.02:
                    warn = {
                        "line": lineno,
                        "key": key,
                        "doc_value": doc_val,
                        "ssot_value": ssot_val,
                        "warning": "RMS_VARIANCE_CONFUSION_WARNING",
                        "hint": "doc ≈ ssot^2" if sq_rel < 0.02 else "doc ≈ sqrt(ssot)",
                    }
                    rms_var_warnings.append(warn)
                    entry["warning"] = warn["warning"]
            drifts.append(entry)

    unchecked_count = len(unresolved_templates) + unchecked_explicit
    passed = (
        len(drifts) == 0
        and len(missing_keys) == 0
        and len(unresolved_templates) == 0
        and matched_count > 0
    )
    if matched_count == 0 and not unresolved_templates and not missing_keys:
        summary = "No SSOT-matched numeric claims found in document"
        status = "FAIL"
    elif passed:
        summary = f"Reconciled {matched_count} numeric claim(s) against {ssot_file.name} with zero drift"
        status = "PASS"
    else:
        summary = (
            f"SSOT reconciliation failed: {len(drifts)} drift(s), "
            f"{len(missing_keys)} missing key(s), "
            f"{len(rms_var_warnings)} RMS/variance warning(s), "
            f"{len(unresolved_templates)} unresolved template(s)"
        )
        status = "FAIL"

    return CheckResult(
        "check_ssot_numbers",
        status,
        summary,
        {
            "checked_count": matched_count,
            "matched_claims": matched_count,
            "missing_keys": missing_keys,
            "unchecked_count": unchecked_count,
            "drifts": drifts,
            "rms_variance_warnings": rms_var_warnings,
            "unresolved_templates": unresolved_templates,
            "rel_tol": rel_tol,
            "abs_tol": abs_tol,
        },
    )


# ---------------------------------------------------------------------------
# 6. Callsite Impact Scan: Detect Half-Baked Patches Missing New Gating/Options
# ---------------------------------------------------------------------------

DEFAULT_SCAN_EXTENSIONS = (".m", ".py", ".ts", ".js", ".cpp", ".c", ".h")
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}


def _extract_balanced_parens(text: str, open_idx: int) -> tuple[str, int]:
    depth = 0
    i = open_idx
    n = len(text)
    in_single = False
    in_double = False
    while i < n:
        ch = text[i]
        prev = text[i - 1] if i > 0 else ""
        if ch == "'" and not in_double and prev != "\\":
            in_single = not in_single
        elif ch == '"' and not in_single and prev != "\\":
            in_double = not in_double
        elif not in_single and not in_double:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return text[open_idx + 1 : i], i
        i += 1
    return text[open_idx + 1 :], n - 1


def _is_test_path(path: Path) -> bool:
    parts = {p.lower() for p in path.parts}
    name = path.name.lower()
    return (
        "__tests__" in parts
        or "tests" in parts
        or "test" in parts
        or name.startswith("test_")
        or ".test." in name
        or ".spec." in name
    )


def check_callsite_impact(
    root_dir: str | Path,
    symbol: str,
    *,
    required_args: Sequence[str] = (),
    extensions: Sequence[str] = DEFAULT_SCAN_EXTENSIONS,
) -> CheckResult:
    """
    Scan source files under `root_dir` for all calls to `symbol(...)`, separating
    definitions from call sites and highlighting production calls that omit any of
    `required_args` (prevents silent fallback to legacy physics when adding `opt`/`el_sd`).
    """
    root = Path(root_dir)
    if not root.exists():
        return CheckResult("check_callsite_impact", "FAIL", f"Root path does not exist: {root}")

    ext_set = {e.lower() if e.startswith(".") else f".{e.lower()}" for e in extensions}
    call_re = re.compile(rf"\b{re.escape(symbol)}\s*\(")
    def_line_re = re.compile(rf"^\s*(?:function\b[^\n]*\b{re.escape(symbol)}\s*\(|def\s+{re.escape(symbol)}\s*\(|(?:export\s+)?(?:async\s+)?function\s+{re.escape(symbol)}\s*\()")

    definitions: list[dict[str, Any]] = []
    production_calls: list[dict[str, Any]] = []
    test_calls: list[dict[str, Any]] = []
    missing_arg_calls: list[dict[str, Any]] = []

    req_patterns = [(arg, re.compile(rf"\b{re.escape(arg)}\b")) for arg in required_args]

    files_to_scan: Iterable[Path]
    if root.is_file():
        files_to_scan = [root]
    else:
        collected: list[Path] = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for fname in sorted(filenames):
                p = Path(dirpath) / fname
                if p.suffix.lower() in ext_set:
                    collected.append(p)
        files_to_scan = collected

    for fpath in files_to_scan:
        try:
            content = fpath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = str(fpath.relative_to(root)) if root.is_dir() else fpath.name
        is_test = _is_test_path(fpath)

        for m in call_re.finditer(content):
            line_start = content.rfind("\n", 0, m.start()) + 1
            line_end = content.find("\n", m.start())
            if line_end == -1:
                line_end = len(content)
            line_text = content[line_start:line_end].strip()
            lineno = content.count("\n", 0, m.start()) + 1

            # Skip comments
            stripped = line_text.lstrip()
            if stripped.startswith(("#", "%", "//", "*")):
                continue

            open_paren_idx = content.find("(", m.start())
            arg_blob, _ = _extract_balanced_parens(content, open_paren_idx)
            arg_blob_compact = " ".join(arg_blob.split())

            if def_line_re.match(line_text):
                definitions.append({"file": rel, "line": lineno, "args": arg_blob_compact})
                continue

            missing = [arg for arg, pat in req_patterns if not pat.search(arg_blob)]
            record = {
                "file": rel,
                "line": lineno,
                "is_test": is_test,
                "args": arg_blob_compact,
                "missing_required_args": missing,
            }
            if is_test:
                test_calls.append(record)
            else:
                production_calls.append(record)
                if missing:
                    missing_arg_calls.append(record)

    total_callsites = len(production_calls)
    if total_callsites == 0:
        status = "WARN"
        coverage = "NO_COVERAGE"
        summary = f"No production calls found for `{symbol}` under {root} (NO_COVERAGE)"
    elif len(missing_arg_calls) > 0:
        status = "FAIL"
        coverage = "OK"
        summary = f"{len(missing_arg_calls)}/{total_callsites} production call(s) to `{symbol}` omit required args {list(required_args)}"
    else:
        status = "PASS"
        coverage = "OK"
        summary = f"Scanned {total_callsites} production call(s) to `{symbol}`: all pass required args {list(required_args)}"

    return CheckResult(
        "check_callsite_impact",
        status,
        summary,
        {
            "symbol": symbol,
            "required_args": list(required_args),
            "definitions": definitions,
            "total_callsites": total_callsites,
            "coverage": coverage,
            "production_call_count": total_callsites,
            "test_call_count": len(test_calls),
            "missing_arg_calls": missing_arg_calls,
            "production_calls": production_calls,
        },
    )


# ---------------------------------------------------------------------------
# 7. SMT Inequality & Counterexample Check (via optional `z3` + AST whitelist)
# ---------------------------------------------------------------------------

_SMT_ALLOWED_SORTS = frozenset({"real", "int", "bool"})
_SMT_RESERVED_NAMES = frozenset({"True", "False", "None", "abs", "min", "max"})
_SMT_MAX_AST_NODES = 1024


class _SmtAstError(ValueError):
    """Raised when an SMT expression violates the strict Python AST whitelist."""


def _normalize_smt_variables(variables: Mapping[str, str] | None) -> dict[str, str]:
    if variables is None:
        return {}
    if not isinstance(variables, Mapping):
        raise _SmtAstError("variables must be a mapping of {name: 'real'|'int'|'bool'}")
    normalized: dict[str, str] = {}
    for raw_name, raw_sort in variables.items():
        if (
            not isinstance(raw_name, str)
            or not raw_name.isidentifier()
            or keyword.iskeyword(raw_name)
            or raw_name in _SMT_RESERVED_NAMES
        ):
            raise _SmtAstError(f"Invalid or reserved SMT variable identifier: {raw_name!r}")
        if not isinstance(raw_sort, str):
            raise _SmtAstError(f"Sort for variable {raw_name!r} must be a string")
        sort_norm = raw_sort.strip().lower()
        if sort_norm not in _SMT_ALLOWED_SORTS:
            raise _SmtAstError(
                f"Unsupported SMT sort {raw_sort!r} for {raw_name!r}; allowed: 'real', 'int', 'bool'"
            )
        normalized[raw_name] = sort_norm
    return normalized


def _infer_and_validate_smt_sort(node: ast.AST, var_sorts: Mapping[str, str]) -> str:
    if isinstance(node, ast.Expression):
        return _infer_and_validate_smt_sort(node.body, var_sorts)

    if isinstance(node, ast.Constant):
        val = node.value
        if isinstance(val, bool):
            return "bool"
        if isinstance(val, int):
            return "int"
        if isinstance(val, float):
            if not math.isfinite(val):
                raise _SmtAstError("Non-finite float constant is not allowed in SMT expressions")
            return "real"
        raise _SmtAstError(f"Disallowed constant literal {val!r}; only numeric/bool constants allowed")

    if isinstance(node, ast.Name):
        if not isinstance(node.ctx, ast.Load):
            raise _SmtAstError("Only Load variable context is allowed")
        if node.id not in var_sorts:
            raise _SmtAstError(f"Undeclared SMT variable or symbol: {node.id!r}")
        return var_sorts[node.id]

    if isinstance(node, ast.UnaryOp):
        op_sort = _infer_and_validate_smt_sort(node.operand, var_sorts)
        if isinstance(node.op, (ast.UAdd, ast.USub)):
            if op_sort not in ("int", "real"):
                raise _SmtAstError("Unary +/- requires a numeric ('int' or 'real') operand")
            return op_sort
        if isinstance(node.op, ast.Not):
            if op_sort != "bool":
                raise _SmtAstError("Boolean 'not' requires a boolean operand")
            return "bool"
        raise _SmtAstError(f"Disallowed unary operator: {type(node.op).__name__}")

    if isinstance(node, ast.BinOp):
        if not isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            raise _SmtAstError(f"Disallowed binary operator: {type(node.op).__name__}")
        l_sort = _infer_and_validate_smt_sort(node.left, var_sorts)
        r_sort = _infer_and_validate_smt_sort(node.right, var_sorts)
        if l_sort not in ("int", "real") or r_sort not in ("int", "real"):
            raise _SmtAstError("Arithmetic operators (+ - * / **) require numeric operands")
        if isinstance(node.op, ast.Div):
            return "real"
        if isinstance(node.op, ast.Pow) and isinstance(node.right, ast.UnaryOp):
            return "real"
        return "real" if ("real" in (l_sort, r_sort)) else "int"

    if isinstance(node, ast.BoolOp):
        if not isinstance(node.op, (ast.And, ast.Or)):
            raise _SmtAstError(f"Disallowed boolean operator: {type(node.op).__name__}")
        for val_node in node.values:
            if _infer_and_validate_smt_sort(val_node, var_sorts) != "bool":
                raise _SmtAstError("Boolean 'and'/'or' requires boolean operands")
        return "bool"

    if isinstance(node, ast.Compare):
        cur_sort = _infer_and_validate_smt_sort(node.left, var_sorts)
        for op, comp in zip(node.ops, node.comparators):
            nxt_sort = _infer_and_validate_smt_sort(comp, var_sorts)
            if isinstance(op, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)):
                if cur_sort not in ("int", "real") or nxt_sort not in ("int", "real"):
                    raise _SmtAstError("Ordering comparisons (< <= > >=) require numeric operands")
            elif isinstance(op, (ast.Eq, ast.NotEq)):
                if (cur_sort == "bool") != (nxt_sort == "bool"):
                    raise _SmtAstError("Equality comparisons (== !=) cannot mix boolean and numeric sorts")
            else:
                raise _SmtAstError(f"Disallowed comparison operator: {type(op).__name__}")
            cur_sort = nxt_sort
        return "bool"

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in ("abs", "min", "max"):
            target = node.func.id if isinstance(node.func, ast.Name) else type(node.func).__name__
            raise _SmtAstError(f"Disallowed function/callable {target!r}; only abs, min, max are allowed")
        if node.keywords:
            raise _SmtAstError("Keyword arguments are not allowed in SMT expressions")
        for arg in node.args:
            if isinstance(arg, ast.Starred):
                raise _SmtAstError("Starred arguments are not allowed in SMT expressions")
        fn_name = node.func.id
        if fn_name == "abs" and len(node.args) != 1:
            raise _SmtAstError("abs() requires exactly 1 numeric argument")
        if fn_name in ("min", "max") and len(node.args) < 2:
            raise _SmtAstError(f"{fn_name}() requires at least 2 numeric arguments")
        arg_sorts = [_infer_and_validate_smt_sort(arg, var_sorts) for arg in node.args]
        if any(s not in ("int", "real") for s in arg_sorts):
            raise _SmtAstError(f"{fn_name}() requires numeric arguments")
        return "real" if "real" in arg_sorts else "int"

    raise _SmtAstError(f"Disallowed AST construct: {type(node).__name__}")


def _parse_smt_formula_ast(expr_text: str, var_sorts: Mapping[str, str]) -> ast.Expression:
    if not isinstance(expr_text, str) or not expr_text.strip():
        raise _SmtAstError("SMT formula string must be non-empty")
    try:
        tree = ast.parse(expr_text, mode="eval")
    except (SyntaxError, ValueError, TypeError, MemoryError, RecursionError) as exc:
        raise _SmtAstError(f"Syntax error in SMT formula {expr_text!r}: {exc}") from exc
    node_count = sum(1 for _ in ast.walk(tree))
    if node_count > _SMT_MAX_AST_NODES:
        raise _SmtAstError(f"SMT formula exceeds max AST node limit ({node_count} > {_SMT_MAX_AST_NODES})")
    top_sort = _infer_and_validate_smt_sort(tree, var_sorts)
    if top_sort != "bool":
        raise _SmtAstError(f"Top-level SMT formula {expr_text!r} must evaluate to a boolean condition, got {top_sort!r}")
    return tree


def _align_z3_arith(lhs: Any, rhs: Any, z3_mod: Any) -> tuple[Any, Any]:
    if z3_mod.is_real(lhs) and z3_mod.is_int(rhs):
        return lhs, z3_mod.ToReal(rhs)
    if z3_mod.is_int(lhs) and z3_mod.is_real(rhs):
        return z3_mod.ToReal(lhs), rhs
    return lhs, rhs


def _compile_smt_ast(node: ast.AST, z3_vars: Mapping[str, Any], z3_mod: Any) -> Any:
    if isinstance(node, ast.Expression):
        return _compile_smt_ast(node.body, z3_vars, z3_mod)

    if isinstance(node, ast.Constant):
        val = node.value
        if isinstance(val, bool):
            return z3_mod.BoolVal(val)
        if isinstance(val, int):
            return z3_mod.IntVal(val)
        if isinstance(val, float):
            return z3_mod.RealVal(str(val))
        raise _SmtAstError(f"Unsupported constant: {val!r}")

    if isinstance(node, ast.Name):
        return z3_vars[node.id]

    if isinstance(node, ast.UnaryOp):
        operand = _compile_smt_ast(node.operand, z3_vars, z3_mod)
        if isinstance(node.op, ast.UAdd):
            return operand
        if isinstance(node.op, ast.USub):
            return -operand
        if isinstance(node.op, ast.Not):
            return z3_mod.Not(operand)
        raise _SmtAstError(f"Unsupported unary op: {type(node.op).__name__}")

    if isinstance(node, ast.BinOp):
        left = _compile_smt_ast(node.left, z3_vars, z3_mod)
        right = _compile_smt_ast(node.right, z3_vars, z3_mod)
        if isinstance(node.op, ast.Div):
            l_real = z3_mod.ToReal(left) if z3_mod.is_int(left) else left
            r_real = z3_mod.ToReal(right) if z3_mod.is_int(right) else right
            return l_real / r_real
        left, right = _align_z3_arith(left, right, z3_mod)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Pow):
            if isinstance(node.right, ast.UnaryOp) and z3_mod.is_int(left):
                left = z3_mod.ToReal(left)
                right = z3_mod.ToReal(right) if z3_mod.is_int(right) else right
            return left ** right
        raise _SmtAstError(f"Unsupported bin op: {type(node.op).__name__}")

    if isinstance(node, ast.BoolOp):
        compiled_vals = [_compile_smt_ast(v, z3_vars, z3_mod) for v in node.values]
        if isinstance(node.op, ast.And):
            return z3_mod.And(*compiled_vals)
        if isinstance(node.op, ast.Or):
            return z3_mod.Or(*compiled_vals)
        raise _SmtAstError(f"Unsupported bool op: {type(node.op).__name__}")

    if isinstance(node, ast.Compare):
        clauses: list[Any] = []
        left = _compile_smt_ast(node.left, z3_vars, z3_mod)
        for op, comp in zip(node.ops, node.comparators):
            right = _compile_smt_ast(comp, z3_vars, z3_mod)
            lhs, rhs = (
                _align_z3_arith(left, right, z3_mod)
                if (z3_mod.is_arith(left) and z3_mod.is_arith(right))
                else (left, right)
            )
            if isinstance(op, ast.Lt):
                clauses.append(lhs < rhs)
            elif isinstance(op, ast.LtE):
                clauses.append(lhs <= rhs)
            elif isinstance(op, ast.Gt):
                clauses.append(lhs > rhs)
            elif isinstance(op, ast.GtE):
                clauses.append(lhs >= rhs)
            elif isinstance(op, ast.Eq):
                clauses.append(lhs == rhs)
            elif isinstance(op, ast.NotEq):
                clauses.append(lhs != rhs)
            else:
                raise _SmtAstError(f"Unsupported compare op: {type(op).__name__}")
            left = right
        return clauses[0] if len(clauses) == 1 else z3_mod.And(*clauses)

    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        args = [_compile_smt_ast(a, z3_vars, z3_mod) for a in node.args]
        fn_name = node.func.id
        if fn_name == "abs":
            x = args[0]
            zero = z3_mod.RealVal(0) if z3_mod.is_real(x) else z3_mod.IntVal(0)
            return z3_mod.If(x >= zero, x, -x)
        if fn_name in ("min", "max"):
            acc = args[0]
            for nxt in args[1:]:
                acc, nxt = _align_z3_arith(acc, nxt, z3_mod)
                cond = (acc <= nxt) if fn_name == "min" else (acc >= nxt)
                acc = z3_mod.If(cond, acc, nxt)
            return acc

    raise _SmtAstError(f"Unsupported AST node during compilation: {type(node).__name__}")


def _z3_val_to_python(val: Any, z3_mod: Any) -> Any:
    if z3_mod.is_true(val):
        return True
    if z3_mod.is_false(val):
        return False
    if z3_mod.is_int_value(val):
        return int(val.as_long())
    if z3_mod.is_rational_value(val):
        num = int(val.numerator_as_long())
        den = int(val.denominator_as_long())
        if den == 1:
            return float(num)
        try:
            approx = num / den
            if math.isfinite(approx):
                return approx
        except OverflowError:
            pass
        return f"{num}/{den}"
    if hasattr(z3_mod, "is_algebraic_value") and z3_mod.is_algebraic_value(val):
        dec = val.as_decimal(12).rstrip("?")
        try:
            return float(dec)
        except ValueError:
            return str(val)
    return str(val)


def _extract_z3_counterexample(
    model: Any,
    z3_vars: Mapping[str, Any],
    z3_mod: Any,
) -> dict[str, Any]:
    ce: dict[str, Any] = {}
    for name, ref in z3_vars.items():
        evaluated = model.eval(ref, model_completion=True)
        ce[name] = _z3_val_to_python(evaluated, z3_mod)
    for decl in model.decls():
        dname = decl.name()
        if dname not in ce and decl.arity() == 0:
            ce[dname] = _z3_val_to_python(model[decl], z3_mod)
    return ce


def check_smt_inequality(
    variables: Mapping[str, str] | None = None,
    assumptions: Sequence[str] = (),
    conclusion: str | None = None,
    *,
    build_problem_fn: Callable[[Any], Any] | None = None,
    timeout_ms: int = 5000,
) -> CheckResult:
    """
    Verify mathematical inequalities / implications using Z3 SMT with:
      1. Strict Python `ast` whitelist parsing (blocks eval/exec/attribute/call injection),
      2. Non-vacuity check (`And(*assumptions)` must not be `unsat`, preventing vacuous truth),
      3. Negated-conclusion counterexample search (`And(*assumptions, Not(conclusion))`),
      4. Graceful structured `SKIP` when `z3-solver` is absent or solver returns `unknown`.
    """
    if timeout_ms <= 0:
        return CheckResult("check_smt_inequality", "FAIL", f"timeout_ms must be > 0, got {timeout_ms}")

    parsed_assumptions: list[ast.Expression] = []
    parsed_conclusion: ast.Expression | None = None
    var_sorts: dict[str, str] = {}

    if build_problem_fn is None:
        if conclusion is None:
            return CheckResult(
                "check_smt_inequality",
                "FAIL",
                "Either `conclusion` (declarative AST mode) or `build_problem_fn` must be provided",
                {"reason": "missing_conclusion"},
            )
        try:
            var_sorts = _normalize_smt_variables(variables)
            if isinstance(assumptions, (str, bytes)):
                raise _SmtAstError("assumptions must be a sequence of formula strings, not a bare string")
            parsed_assumptions = [_parse_smt_formula_ast(expr, var_sorts) for expr in assumptions]
            parsed_conclusion = _parse_smt_formula_ast(conclusion, var_sorts)
        except _SmtAstError as exc:
            return CheckResult(
                "check_smt_inequality",
                "FAIL",
                f"SMT AST whitelist check rejected input: {exc}",
                {"reason": "ast_whitelist_violation", "error": str(exc)},
            )

    try:
        import z3  # type: ignore
    except ImportError:
        return CheckResult(
            "check_smt_inequality",
            "SKIP",
            "z3-solver not installed; skipping SMT inequality verification (install z3-solver==5.4.1.0 to enable)",
            {"missing_package": "z3-solver"},
        )

    z3_vars: dict[str, Any] = {}
    if build_problem_fn is not None:
        try:
            built = build_problem_fn(z3)
            if isinstance(built, Mapping):
                raw_vars_map = built.get("variables")
                if isinstance(raw_vars_map, Mapping):
                    z3_vars = {str(k): v for k, v in raw_vars_map.items()}
                z3_assumptions = list(built.get("assumptions", ()))
                z3_conclusion = built["conclusion"]
            elif isinstance(built, tuple) and len(built) == 2:
                z3_assumptions = list(built[0])
                z3_conclusion = built[1]
            elif isinstance(built, tuple) and len(built) == 3 and isinstance(built[0], Mapping):
                z3_vars = {str(k): v for k, v in built[0].items()}
                z3_assumptions = list(built[1])
                z3_conclusion = built[2]
            else:
                return CheckResult(
                    "check_smt_inequality",
                    "FAIL",
                    "build_problem_fn must return (assumptions, conclusion) or {'assumptions': [...], 'conclusion': ...}",
                    {"reason": "invalid_callback_return"},
                )
        except Exception as exc:  # noqa: BLE001
            return CheckResult(
                "check_smt_inequality",
                "FAIL",
                f"build_problem_fn failed: {exc}",
                {"reason": "callback_error", "error": str(exc)},
            )
    else:
        for name, sort_name in var_sorts.items():
            if sort_name == "real":
                z3_vars[name] = z3.Real(name)
            elif sort_name == "int":
                z3_vars[name] = z3.Int(name)
            else:
                z3_vars[name] = z3.Bool(name)
        assert parsed_conclusion is not None
        z3_assumptions = [_compile_smt_ast(tree, z3_vars, z3) for tree in parsed_assumptions]
        z3_conclusion = _compile_smt_ast(parsed_conclusion, z3_vars, z3)

    # Step 1: Non-vacuity / inhabitation check on assumptions
    if len(z3_assumptions) > 0:
        vac_solver = z3.Solver()
        vac_solver.set("timeout", int(timeout_ms))
        vac_solver.add(z3.And(*z3_assumptions))
        vac_res = vac_solver.check()
        if vac_res == z3.unsat:
            return CheckResult(
                "check_smt_inequality",
                "FAIL",
                "Assumptions are mutually contradictory (unsat); rejecting vacuous truth",
                {
                    "reason": "vacuous_assumptions",
                    "assumptions_count": len(z3_assumptions),
                    "timeout_ms": timeout_ms,
                },
            )
        if vac_res != z3.sat:
            return CheckResult(
                "check_smt_inequality",
                "SKIP",
                f"Z3 returned unknown while checking assumption non-vacuity ({vac_solver.reason_unknown()})",
                {
                    "reason": "z3_unknown_or_timeout",
                    "phase": "non_vacuity",
                    "z3_reason": vac_solver.reason_unknown(),
                    "timeout_ms": timeout_ms,
                },
            )

    # Step 2: Refutation search on And(*assumptions, Not(conclusion))
    solver = z3.Solver()
    solver.set("timeout", int(timeout_ms))
    if z3_assumptions:
        solver.add(z3.And(*z3_assumptions, z3.Not(z3_conclusion)))
    else:
        solver.add(z3.Not(z3_conclusion))

    res = solver.check()
    if res == z3.unsat:
        return CheckResult(
            "check_smt_inequality",
            "PASS",
            f"SMT inequality proved universally valid ({len(z3_assumptions)} non-vacuous assumption(s))",
            {
                "assumptions_count": len(z3_assumptions),
                "non_vacuous": True,
                "timeout_ms": timeout_ms,
            },
        )
    if res == z3.sat:
        counterexample = _extract_z3_counterexample(solver.model(), z3_vars, z3)
        return CheckResult(
            "check_smt_inequality",
            "FAIL",
            f"SMT counterexample found: {counterexample}",
            {
                "counterexample": counterexample,
                "assumptions_count": len(z3_assumptions),
                "timeout_ms": timeout_ms,
            },
        )
    return CheckResult(
        "check_smt_inequality",
        "SKIP",
        f"Z3 solver returned unknown or timed out ({solver.reason_unknown()})",
        {
            "reason": "z3_unknown_or_timeout",
            "z3_reason": solver.reason_unknown(),
            "timeout_ms": timeout_ms,
        },
    )


# ---------------------------------------------------------------------------
# Self-Test Suite (tests positive PASS and negative FAIL detection for all 7)
# ---------------------------------------------------------------------------

def run_self_test() -> dict[str, Any]:
    import tempfile

    probes = probe_optional_packages()
    results: list[dict[str, Any]] = []
    all_ok = True

    def _record(name: str, ok: bool, detail: Any) -> None:
        nonlocal all_ok
        if not ok:
            all_ok = False
        results.append({"test": name, "ok": ok, "detail": detail})

    # 1. Jacobian parity (good vs buggy Jacobian)
    def _polar_to_cart(x: np.ndarray) -> np.ndarray:
        r, theta = x[0], x[1]
        return np.array([r * np.cos(theta), r * np.sin(theta)])

    def _good_jac(x: np.ndarray) -> np.ndarray:
        r, theta = x[0], x[1]
        return np.array([[np.cos(theta), -r * np.sin(theta)], [np.sin(theta), r * np.cos(theta)]])

    def _buggy_jac(x: np.ndarray) -> np.ndarray:
        r, theta = x[0], x[1]
        # Missing `r` factor (classic sin(z0)/polar_to_local Jacobian omission!)
        return np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])

    j_pass = check_jacobian_parity(_polar_to_cart, _good_jac, [12.5, 0.73], use_complex_step=True)
    j_fail = check_jacobian_parity(_polar_to_cart, _buggy_jac, [12.5, 0.73])
    _record("jacobian_good_pass", j_pass.status == "PASS", j_pass.to_dict())
    _record("jacobian_buggy_caught", j_fail.status == "FAIL", j_fail.to_dict())

    # 2. SO(3) invariants (proper rotation vs improper reflection det=-1)
    ang = 0.42
    r_good = np.array([[math.cos(ang), -math.sin(ang), 0.0], [math.sin(ang), math.cos(ang), 0.0], [0.0, 0.0, 1.0]])
    r_refl = np.diag([1.0, 1.0, -1.0]) @ r_good
    s_pass = check_so3_invariants(r_good)
    s_fail = check_so3_invariants(r_refl)
    _record("so3_proper_pass", s_pass.status == "PASS", s_pass.to_dict())
    _record("so3_reflection_caught", s_fail.status == "FAIL", s_fail.to_dict())

    # 3. Non-zero asymmetric roundtrip fuzzing (valid transform vs silent legacy collapse)
    a_rot = np.array([[math.cos(0.31), -math.sin(0.31), 0.0], [math.sin(0.31), math.cos(0.31), 0.0], [0.0, 0.0, 1.0]])
    shift = np.array([15.2, -27.8, 44.1])
    rt_pass = check_nonzero_roundtrip(
        lambda v: a_rot @ v + shift,
        lambda w: a_rot.T @ (w - shift),
        dim=3,
        baseline_output_fn=lambda v: v,
    )
    # Simulate a gated option bug where forward silently falls back to baseline (identity)
    rt_fail = check_nonzero_roundtrip(
        lambda v: v,
        lambda w: a_rot.T @ (w - shift),
        dim=3,
        baseline_output_fn=lambda v: v,
    )
    _record("roundtrip_nonzero_pass", rt_pass.status == "PASS", rt_pass.to_dict())
    _record("roundtrip_silent_fallback_caught", rt_fail.status == "FAIL", rt_fail.to_dict())

    # 4. Dimensional consistency (PASS/FAIL when pint installed, SKIP when absent)
    d_res = check_dimensions([
        {"name": "newton_second_law", "lhs": "kg * m / s^2", "rhs": "N"},
        {"name": "phase_to_range", "lhs": "m", "rhs": "m / rad * rad"},
    ])
    if probes["pint"]["available"]:
        d_bad = check_dimensions([{"name": "bad_unit", "lhs": "m / s", "rhs": "m / s^2"}])
        _record("dimensions_pass", d_res.status == "PASS", d_res.to_dict())
        _record("dimensions_mismatch_caught", d_bad.status == "FAIL", d_bad.to_dict())
    else:
        _record("dimensions_graceful_skip", d_res.status == "SKIP", d_res.to_dict())

    # 5. SSOT reconciliation + RMS vs variance confusion warning
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        metrics_path = tmp / "metrics.json"
        metrics_path.write_text(
            json.dumps({"huber_scale": 0.8881, "pos_rms_mm": 6.56}),
            encoding="utf-8",
        )
        good_md = tmp / "good.md"
        good_md.write_text(
            "| Metric | Value |\n| --- | --- |\n| huber_scale | 0.8881 |\n| pos_rms_mm | 6.56 |\n",
            encoding="utf-8",
        )
        bad_md = tmp / "bad.md"
        # Simulate Huber 0.8881 vs 0.6745 drift + RMS (6.56) reported as variance (43.0336)
        bad_md.write_text(
            "huber_scale = 0.6745\n| pos_rms_mm | 43.0336 |\n",
            encoding="utf-8",
        )
        ssot_pass = check_ssot_numbers(good_md, metrics_path)
        ssot_fail = check_ssot_numbers(bad_md, metrics_path)
        missing_md = tmp / "missing_key.md"
        missing_md.write_text(
            "<!-- ssot:huber_scale --> 0.8881\n<!-- ssot:missing_key --> 1.23\n{{metrics.missing_tmpl}}\n",
            encoding="utf-8",
        )
        ssot_missing = check_ssot_numbers(missing_md, metrics_path)
        _record("ssot_reconciled_pass", ssot_pass.status == "PASS", ssot_pass.to_dict())
        _record(
            "ssot_drift_and_rms_var_caught",
            ssot_fail.status == "FAIL" and len(ssot_fail.details.get("rms_variance_warnings", [])) == 1,
            ssot_fail.to_dict(),
        )
        _record(
            "ssot_missing_key_fails",
            (
                ssot_missing.status == "FAIL"
                and ssot_missing.details.get("checked_count") == 1
                and "missing_key" in ssot_missing.details.get("missing_keys", [])
                and "missing_tmpl" in ssot_missing.details.get("missing_keys", [])
                and ssot_missing.details.get("unchecked_count", 0) >= 2
            ),
            ssot_missing.to_dict(),
        )

        # 6. Callsite impact scan (catch production call omitting `opt` & warn on zero coverage)
        src_dir = tmp / "matlab_proj"
        (src_dir / "tests").mkdir(parents=True)
        (src_dir / "polar_to_local.m").write_text(
            "function xyz = polar_to_local(az, el, rng, opt)\n  xyz = [az; el; rng];\nend\n",
            encoding="utf-8",
        )
        (src_dir / "prod_good.m").write_text(
            "p1 = polar_to_local(az, el, r, opt);\n",
            encoding="utf-8",
        )
        (src_dir / "prod_stale.m").write_text(
            "p2 = polar_to_local(az, el, r);\n",
            encoding="utf-8",
        )
        (src_dir / "tests" / "test_polar.m").write_text(
            "p3 = polar_to_local(az, el, r, opt);\n",
            encoding="utf-8",
        )
        cs_fail = check_callsite_impact(src_dir, "polar_to_local", required_args=["opt"])
        (src_dir / "prod_stale.m").write_text(
            "p2 = polar_to_local(az, el, r, opt);\n",
            encoding="utf-8",
        )
        cs_pass = check_callsite_impact(src_dir, "polar_to_local", required_args=["opt"])
        cs_zero = check_callsite_impact(src_dir, "nonexistent_symbol", required_args=["opt"])
        _record(
            "callsite_missing_opt_caught",
            cs_fail.status == "FAIL" and len(cs_fail.details["missing_arg_calls"]) == 1,
            cs_fail.to_dict(),
        )
        _record("callsite_clean_pass", cs_pass.status == "PASS", cs_pass.to_dict())
        _record(
            "callsite_zero_coverage_warns",
            (
                cs_zero.status == "WARN"
                and cs_zero.details.get("total_callsites") == 0
                and cs_zero.details.get("coverage") == "NO_COVERAGE"
            ),
            cs_zero.to_dict(),
        )

        # 7. SMT inequality verification: AST whitelist (always) + Z3 PASS/FAIL/vacuous or graceful SKIP
        smt_bad_import = check_smt_inequality(
            {"x": "real"},
            ["x > 0"],
            "__import__('os').system('id') == 0",
        )
        smt_bad_attr = check_smt_inequality(
            {"x": "real"},
            ["x.__class__ == 1"],
            "x > 0",
        )
        smt_bad_eval = check_smt_inequality(
            {"x": "real"},
            ["eval('1 + 1') == 2"],
            "x > 0",
        )
        smt_bad_undeclared = check_smt_inequality(
            {"x": "real"},
            ["x > 0"],
            "undeclared_var > 0",
        )
        smt_bad_nonbool = check_smt_inequality(
            {"x": "real"},
            ["x > 0"],
            "x + 1",
        )
        _record(
            "smt_ast_whitelist_blocks_injection",
            all(
                r.status == "FAIL" and r.details.get("reason") == "ast_whitelist_violation"
                for r in (smt_bad_import, smt_bad_attr, smt_bad_eval, smt_bad_undeclared, smt_bad_nonbool)
            ),
            {
                "import_call": smt_bad_import.to_dict(),
                "attr_access": smt_bad_attr.to_dict(),
                "eval_call": smt_bad_eval.to_dict(),
                "undeclared_var": smt_bad_undeclared.to_dict(),
                "non_bool_top": smt_bad_nonbool.to_dict(),
            },
        )

        smt_valid = check_smt_inequality(
            {"a": "real", "b": "real"},
            ["a >= 0", "b >= 0"],
            "a * a + b * b >= 2 * a * b and abs(a - b) >= max(a, b) - min(a, b)",
        )
        if probes["z3"]["available"]:
            smt_cb = check_smt_inequality(
                build_problem_fn=lambda z3_mod: (
                    [z3_mod.Real("u") > 1],
                    z3_mod.Real("u") * z3_mod.Real("u") > z3_mod.Real("u"),
                )
            )
            smt_ce = check_smt_inequality(
                {"x": "real", "y": "real"},
                ["x > 0", "y > 0"],
                "x + y > x * y",
            )
            smt_vac = check_smt_inequality(
                {"x": "real"},
                ["x > 10", "x < 2"],
                "x == 999",
            )
            _record(
                "smt_inequality_pass",
                smt_valid.status == "PASS" and smt_cb.status == "PASS",
                {"declarative": smt_valid.to_dict(), "callback": smt_cb.to_dict()},
            )
            _record(
                "smt_counterexample_caught",
                (
                    smt_ce.status == "FAIL"
                    and isinstance(smt_ce.details.get("counterexample"), dict)
                    and set(smt_ce.details["counterexample"].keys()) == {"x", "y"}
                ),
                smt_ce.to_dict(),
            )
            _record(
                "smt_vacuous_assumptions_caught",
                smt_vac.status == "FAIL" and smt_vac.details.get("reason") == "vacuous_assumptions",
                smt_vac.to_dict(),
            )
        else:
            _record(
                "smt_graceful_skip",
                smt_valid.status == "SKIP" and smt_valid.details.get("missing_package") == "z3-solver",
                smt_valid.to_dict(),
            )

        # 8. Witness verdict emission protocol (OC_WITNESS_VERDICT_FILE + stdout sentinel)
        import contextlib
        import io

        verdict_path = tmp / "witness_verdict.json"
        prev_file = os.environ.get("OC_WITNESS_VERDICT_FILE")
        prev_digest = os.environ.get("OC_WITNESS_FINDING_DIGEST")
        buf = io.StringIO()
        try:
            os.environ["OC_WITNESS_VERDICT_FILE"] = str(verdict_path)
            os.environ["OC_WITNESS_FINDING_DIGEST"] = "a" * 64
            with contextlib.redirect_stdout(buf):
                payload = emit_witness_verdict("confirmed", "FWL residual 7.55e-15", metric="fwl_err")
        finally:
            if prev_file is None:
                os.environ.pop("OC_WITNESS_VERDICT_FILE", None)
            else:
                os.environ["OC_WITNESS_VERDICT_FILE"] = prev_file
            if prev_digest is None:
                os.environ.pop("OC_WITNESS_FINDING_DIGEST", None)
            else:
                os.environ["OC_WITNESS_FINDING_DIGEST"] = prev_digest

        written_verdict = json.loads(verdict_path.read_text(encoding="utf-8")) if verdict_path.exists() else {}
        stdout_text = buf.getvalue().strip()
        _record(
            "emit_witness_verdict_protocol",
            (
                payload.get("status") == "confirmed"
                and written_verdict == payload
                and written_verdict.get("finding_digest") == "a" * 64
                and stdout_text.startswith("OC_WITNESS_VERDICT: ")
                and json.loads(stdout_text.split("OC_WITNESS_VERDICT: ", 1)[1]) == payload
            ),
            {"payload": payload, "stdout": stdout_text},
        )

    return {
        "self_test_passed": all_ok,
        "python_version": sys.version.split()[0],
        "optional_packages": probes,
        "results": results,
    }


# ---------------------------------------------------------------------------
# CLI Entrypoint
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Cleanroom deterministic scientific verification template")
    p.add_argument("--self-test", action="store_true", help="Run built-in verification self-test suite")
    p.add_argument(
        "--mode",
        choices=["so3", "dimensions", "ssot", "callsite", "smt", "probe"],
        help="Run a single reusable verification check from CLI",
    )
    p.add_argument("--matrix", help="JSON 3x3 matrix string for --mode so3")
    p.add_argument("--lhs", help="LHS unit expression for --mode dimensions")
    p.add_argument("--rhs", help="RHS unit expression for --mode dimensions")
    p.add_argument("--spec", help="JSON spec file for --mode dimensions")
    p.add_argument("--doc", help="Markdown/report file for --mode ssot")
    p.add_argument("--ssot", help="metrics.json or CSV path for --mode ssot")
    p.add_argument("--rel-tol", type=float, default=1e-4, help="Relative tolerance for --mode ssot")
    p.add_argument("--abs-tol", type=float, default=1e-6, help="Absolute tolerance for --mode ssot")
    p.add_argument("--root", help="Source root directory for --mode callsite")
    p.add_argument("--symbol", help="Function/symbol name for --mode callsite")
    p.add_argument("--required-arg", action="append", default=[], help="Required arg name for --mode callsite")
    p.add_argument("--vars", help="JSON dict of {var: 'real'|'int'|'bool'} for --mode smt")
    p.add_argument("--assume", action="append", default=[], help="Assumption formula for --mode smt (repeatable)")
    p.add_argument("--conclude", help="Target conclusion formula for --mode smt")
    p.add_argument("--timeout-ms", type=int, default=5000, help="Z3 solver timeout in ms for --mode smt")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.self_test:
        report = run_self_test()
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0 if report["self_test_passed"] else 1

    if args.mode == "probe":
        print(json.dumps(probe_optional_packages(), indent=2, ensure_ascii=False))
        return 0

    if args.mode == "so3":
        if not args.matrix:
            parser.error("--matrix is required for --mode so3")
        res = check_so3_invariants(json.loads(args.matrix))
    elif args.mode == "dimensions":
        if args.spec:
            eqs = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        elif args.lhs and args.rhs:
            eqs = [{"name": "cli_equation", "lhs": args.lhs, "rhs": args.rhs}]
        else:
            parser.error("--spec or (--lhs and --rhs) required for --mode dimensions")
        res = check_dimensions(eqs)
    elif args.mode == "ssot":
        if not args.doc or not args.ssot:
            parser.error("--doc and --ssot are required for --mode ssot")
        res = check_ssot_numbers(args.doc, args.ssot, rel_tol=args.rel_tol, abs_tol=args.abs_tol)
    elif args.mode == "callsite":
        if not args.root or not args.symbol:
            parser.error("--root and --symbol are required for --mode callsite")
        res = check_callsite_impact(args.root, args.symbol, required_args=args.required_arg)
    elif args.mode == "smt":
        if not args.conclude:
            parser.error("--conclude is required for --mode smt")
        try:
            smt_vars = json.loads(args.vars) if args.vars else {}
        except json.JSONDecodeError as exc:
            parser.error(f"--vars must be valid JSON: {exc}")
        if not isinstance(smt_vars, dict):
            parser.error("--vars must decode to a JSON object mapping variable names to 'real'|'int'|'bool'")
        res = check_smt_inequality(
            smt_vars,
            args.assume,
            args.conclude,
            timeout_ms=args.timeout_ms,
        )
    else:
        parser.print_help()
        return 2

    print(json.dumps(res.to_dict(), indent=2, ensure_ascii=False))
    return 1 if res.status == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
