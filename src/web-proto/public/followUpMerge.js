(function attachFollowUpMerge(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PolicyTranslatorFollowUps = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFollowUpMerge() {
  const SUCCESS = new Set(["created", "reused"]);

  function actionKinds(item) {
    if (Array.isArray(item.actionKinds)) return [...new Set(item.actionKinds.map(String))];
    return item.kind ? [String(item.kind)] : [];
  }

  function applyProgressPresentation(result) {
    if (!result || result.status === "failed") {
      return { className: "failed", icon: "×" };
    }
    if (result.status === "manual" || result.status === "skipped") {
      return { className: "manual", icon: "!" };
    }
    return { className: "done", icon: "✓" };
  }

  function unselectedItem(item) {
    const validationSteps = Array.isArray(item.manual?.steps) ? item.manual.steps : [];
    return {
      ...item,
      reason: "The automated action for this source capability was not selected or applied in this run.",
      manual: {
        recreatable: true,
        heading: "How to complete this unselected capability",
        note: "No tenant change was made for this capability in this run.",
        steps: [
          "Return to the migration plan and select the corresponding automated action, or configure the capability manually.",
          "Apply the change and confirm the action reports created or reused.",
          ...validationSteps,
        ],
      },
    };
  }

  function plannedItem(item) {
    const validationSteps = Array.isArray(item.manual?.steps) ? item.manual.steps : [];
    return {
      ...item,
      reason: [
        "This action was planned in simulation only; no tenant change was made.",
        item.reason || "",
      ].filter(Boolean).join(" "),
      manual: {
        recreatable: true,
        heading: "How to validate after applying this plan",
        note: "Run the real apply or generated package before treating these validation steps as applicable.",
        steps: [
          "Apply the selected action to the target External ID tenant.",
          "Confirm the action reports created or reused.",
          ...validationSteps,
        ],
      },
    };
  }

  function incompleteItem(item) {
    const remainingSteps = Array.isArray(item.manual?.steps) ? item.manual.steps : [];
    return {
      ...item,
      reason: [
        "The corresponding apply action did not complete successfully.",
        item.reason || "",
      ].filter(Boolean).join(" "),
      manual: {
        recreatable: true,
        heading: "How to resolve and complete this capability",
        note: "Resolve the apply result first, then complete the remaining configuration or validation work.",
        steps: [
          "Review the failed, skipped, or manual apply result for the corresponding action.",
          "Resolve the reported permissions, prerequisites, or configuration issue.",
          "Re-run the action and confirm it reports created or reused before continuing.",
          ...remainingSteps,
        ],
      },
    };
  }

  function mergeApplyGapItems({
    analysisGaps = [],
    runtimeFollowUps = [],
    applied = [],
    simulated = false,
  } = {}) {
    const appliedByKind = new Map(applied.map((item) => [String(item.kind || ""), item]));
    const runtimeItems = runtimeFollowUps.map((item) => {
      const normalized = {
        ...item,
        actionKinds: actionKinds(item),
        reason: (
        item.status === "failed"
          ? "Failed: "
          : item.status === "skipped"
            ? "Skipped: "
            : ""
        ) + (item.reason || ""),
      };
      const outcome = item.kind ? appliedByKind.get(String(item.kind)) : undefined;
      if (simulated || outcome?.status === "planned") return plannedItem(normalized);
      if (
        item.status === "failed" ||
        item.status === "skipped" ||
        outcome?.status === "failed" ||
        outcome?.status === "skipped"
      ) {
        return incompleteItem(normalized);
      }
      return normalized;
    });

    const analysisItems = [];
    for (const item of analysisGaps) {
      const kinds = actionKinds(item);
      const overlappingRuntime = runtimeFollowUps.filter((followUp) =>
        actionKinds(followUp).some((kind) => kinds.includes(kind))
      );
      if (overlappingRuntime.length) {
        const outcomes = kinds.map((kind) => appliedByKind.get(kind));
        if (
          outcomes.length &&
          outcomes.every((outcome) => outcome && SUCCESS.has(outcome.status))
        ) {
          continue;
        }
        if (simulated || outcomes.some((outcome) => outcome?.status === "planned")) {
          analysisItems.push(plannedItem(item));
        } else {
          analysisItems.push(incompleteItem(item));
        }
        continue;
      }
      if (!kinds.length) {
        analysisItems.push(item);
        continue;
      }

      const outcomes = kinds.map((kind) => appliedByKind.get(kind));
      if (outcomes.some((outcome) => !outcome)) {
        analysisItems.push(unselectedItem(item));
        continue;
      }
      if (simulated || outcomes.some((outcome) => outcome.status === "planned")) {
        analysisItems.push(plannedItem(item));
        continue;
      }
      if (outcomes.every((outcome) => SUCCESS.has(outcome.status))) {
        analysisItems.push(item);
        continue;
      }
      analysisItems.push(incompleteItem(item));
    }

    const seen = new Set();
    const merged = [];
    for (const item of [...runtimeItems, ...analysisItems]) {
      const sourceKey = item.kind
        ? `runtime:${item.kind}`
        : `analysis:${item.followUpType || "manual"}`;
      const key = `${String(item.label || "").trim().toLowerCase()}|${sourceKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  }

  return { applyProgressPresentation, mergeApplyGapItems };
});
