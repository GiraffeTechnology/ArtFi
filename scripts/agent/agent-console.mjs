// UI adapter contract only. A trusted application root supplies authenticated
// durable API + user-controlled wallet adapters; no key custody or demo fallback.
import { INTENT_FIELDS } from "./bounded-intent.mjs";
const fields = [
  "intentId",
  "principal",
  "wallet",
  "assetScope",
  "actionScope",
  "maxUnitPrice",
  "minUnitPrice",
  "maxTransactionValue",
  "maxAggregateExposure",
  "maxExecutions",
  "maxOpenOrders",
  "validFrom",
  "validUntil",
  "allowedCounterpartyPolicy",
  "allowedVenuePolicy",
  "jurisdictionPolicy",
  "slippageLimit",
  "settlementPolicy",
  "nonce",
  "revocationRef",
];
const operationStates = new Set([
  "PREPARED",
  "STARTED",
  "SUBMITTED",
  "CONFIRMED",
  "UNKNOWN",
  "RECONCILING",
  "SAFE_DEGRADED",
  "SETTLED",
  "TERMINAL_REJECTED",
]);
const stable = (code) => {
  throw new Error(code);
};
export function validateDraft(draft) {
  if (
    !draft ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(draft.operationId ?? "") ||
    draft.mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    !draft.intent ||
    Object.keys(draft.intent).length !== fields.length ||
    fields.some((k) => typeof draft.intent[k] !== "string") ||
    draft.intent.actionScope !== "1" ||
    draft.intent.maxExecutions !== "1" ||
    draft.intent.maxOpenOrders !== "0" ||
    draft.intent.slippageLimit !== "0" ||
    String(draft.domain?.chainId) !== "560048" ||
    draft.domain?.name !== "ArtFi Bounded Intent" ||
    draft.domain?.version !== "1" ||
    !/^0x[0-9a-fA-F]{40}$/.test(draft.domain?.verifyingContract ?? "")
  )
    stable("DRAFT_BOUNDARY_INVALID");
  for (const { name, type } of INTENT_FIELDS) {
    const v = draft.intent[name];
    if (
      type === "uint256" &&
      (!/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) >= 2n ** 256n)
    )
      stable("DRAFT_BOUNDARY_INVALID");
    if (
      type === "address" &&
      (!/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0{40}$/.test(v))
    )
      stable("DRAFT_BOUNDARY_INVALID");
    if (
      type === "bytes32" &&
      (!/^0x[0-9a-f]{64}$/.test(v) || /^0x0{64}$/.test(v))
    )
      stable("DRAFT_BOUNDARY_INVALID");
  }
  if (
    draft.intent.principal.toLowerCase() !==
      draft.intent.wallet.toLowerCase() ||
    BigInt(draft.intent.minUnitPrice) > BigInt(draft.intent.maxUnitPrice) ||
    BigInt(draft.intent.validUntil) <= BigInt(draft.intent.validFrom)
  )
    stable("DRAFT_BOUNDARY_INVALID");
  return structuredClone(draft);
}

export function mountAgentConsole(
  root,
  { api, wallet, clock = Date.now, maxObservationAgeMs = 30000 },
) {
  if (
    typeof clock !== "function" ||
    !Number.isSafeInteger(maxObservationAgeMs) ||
    maxObservationAgeMs < 1 ||
    maxObservationAgeMs > 60000
  )
    stable("UI_FRESHNESS_POLICY_INVALID");
  const d = root.ownerDocument;
  const el = (tag, text, attributes = {}) => {
    const n = d.createElement(tag);
    if (text !== undefined) n.textContent = text;
    for (const [k, v] of Object.entries(attributes)) n.setAttribute(k, v);
    return n;
  };
  root.replaceChildren();
  root.append(
    el("h1", "ArtFi Agent"),
    el("p", "TEST_ONLY_NO_REAL_VALUE · 单 NFT BUY · 非托管授权", {
      class: "scope",
    }),
  );
  const notice = el("p", "尚未连接执行与持久化接口。未知状态不代表成功。", {
    role: "status",
    "aria-live": "polite",
  });
  root.append(notice);
  const form = el("form");
  form.append(el("h2", "创建有界 intent"));
  const inputs = {};
  for (const [name, label, value] of [
    ["contract", "NFT 合约地址", ""],
    ["tokenId", "Token ID", ""],
    ["maxUnitPrice", "最高单价（最小货币单位）", ""],
    ["validUntil", "到期 Unix 秒", ""],
  ]) {
    const id = "agent-" + name,
      input = el("input", undefined, {
        id,
        name,
        required: "",
        autocomplete: "off",
        ...(name === "contract"
          ? {}
          : { inputmode: "numeric", pattern: "(0|[1-9][0-9]*)" }),
      });
    input.value = value;
    inputs[name] = input;
    form.append(el("label", label, { for: id }), input);
  }
  const prepare = el("button", "准备授权草案", { type: "submit" });
  form.append(prepare);
  root.append(form);
  const draftSection = el("section", undefined, {
    "aria-label": "完整签名授权范围",
  });
  draftSection.append(
    el("h2", "完整签名授权范围"),
    el(
      "p",
      "仅此初始授权需要用户钱包签名；后续范围内执行无需逐笔人工确认。撤销在链上确认前不视为生效。",
    ),
  );
  const draftView = el("pre", "尚无草案"),
    signButton = el("button", "钱包签名并创建 intent", {
      type: "button",
      disabled: "",
    });
  draftSection.append(draftView, signButton);
  root.append(draftSection);
  const loadSection = el("section", undefined, { "aria-label": "查看与恢复" });
  loadSection.append(el("h2", "查看与恢复"));
  const selected = el("input", undefined, {
    id: "agent-intent-id",
    autocomplete: "off",
  });
  const refresh = el("button", "读取最新状态", { type: "button" }),
    revoke = el("button", "通过钱包撤销 nonce", {
      type: "button",
      disabled: "",
    });
  loadSection.append(
    el("label", "Intent / operation ID", { for: "agent-intent-id" }),
    selected,
    refresh,
    revoke,
  );
  const list = el("dl"),
    values = {};
  for (const [key, label] of [
    ["identity", "链上资产身份"],
    ["grounding", "Grounding"],
    ["execution", "执行"],
    ["reconciliation", "对账"],
    ["recovery", "恢复"],
    ["revocation", "撤销"],
    ["transaction", "交易"],
    ["observedAt", "观测时间"],
  ]) {
    const dd = el("dd", "UNKNOWN");
    values[key] = dd;
    list.append(el("dt", label), dd);
  }
  loadSection.append(list);
  root.append(loadSection);
  let draft = null,
    current = null,
    busy = false,
    disposed = false;
  const ready =
    api &&
    wallet &&
    ["prepareIntent", "createIntent", "getIntent", "recordRevocation"].every(
      (k) => typeof api[k] === "function",
    ) &&
    ["signIntent", "revokeNonce"].every((k) => typeof wallet[k] === "function");
  const methods = ready
    ? Object.fromEntries(
        ["prepareIntent", "createIntent", "getIntent", "recordRevocation"].map(
          (k) => [k, api[k].bind(api)],
        ),
      )
    : null;
  const sign = ready ? wallet.signIntent.bind(wallet) : null,
    revokeNonce = ready ? wallet.revokeNonce.bind(wallet) : null;
  function controls() {
    for (const input of Object.values(inputs)) input.disabled = busy || !ready;
    for (const b of [prepare, refresh]) b.disabled = busy || !ready;
    signButton.disabled = busy || !ready || !draft;
    revoke.disabled =
      busy || !ready || !current || current.revocation.state === "CONFIRMED";
    selected.disabled = busy;
  }
  function resetObservation() {
    current = null;
    for (const value of Object.values(values)) value.textContent = "UNKNOWN";
  }
  function show(record, id) {
    if (
      !record ||
      record.id !== id ||
      record.mode !== "TEST_ONLY_NO_REAL_VALUE" ||
      !record.intent ||
      !record.asset ||
      String(record.asset.chainId) !== "560048" ||
      !/^0x[0-9a-fA-F]{40}$/.test(record.asset.contract ?? "") ||
      !/^(0|[1-9][0-9]*)$/.test(record.asset.tokenId ?? "") ||
      !operationStates.has(record.execution?.state) ||
      !["UNVERIFIED", "CURRENT", "RESTRICTED", "STALE"].includes(
        record.grounding?.state,
      ) ||
      !["UNKNOWN", "RECONCILING", "MATCHED", "MISMATCH"].includes(
        record.reconciliation?.state,
      ) ||
      ![
        "UNKNOWN",
        "RECOVERED",
        "SAFE_DEGRADED",
        "RECONCILING",
        "STOPPED",
      ].includes(record.recovery?.state) ||
      !["NOT_REQUESTED", "PENDING", "CONFIRMED", "UNKNOWN"].includes(
        record.revocation?.state,
      ) ||
      typeof record.fresh !== "boolean" ||
      !Number.isSafeInteger(record.observedAt)
    )
      stable("STATUS_RESPONSE_INVALID");
    if (
      (record.recovery.state === "STOPPED") !==
      (record.execution.state === "TERMINAL_REJECTED")
    )
      stable("STATUS_RESPONSE_INVALID");
    validateDraft({
      operationId: record.id,
      mode: record.mode,
      intent: record.intent,
      domain: record.domain,
    });
    if (
      record.executor?.toLowerCase() !==
      record.domain.verifyingContract.toLowerCase()
    )
      stable("STATUS_RESPONSE_INVALID");
    const now = clock();
    if (!Number.isSafeInteger(now)) stable("UI_CLOCK_INVALID");
    record = structuredClone(record);
    record.fresh =
      record.fresh &&
      record.observedAt <= now + 5000 &&
      now - record.observedAt <= maxObservationAgeMs;
    if (
      record.execution.state === "SETTLED" &&
      (record.execution.canonical !== true ||
        record.reconciliation.state !== "MATCHED" ||
        record.reconciliation.accountingMatches !== true)
    )
      record.execution.state = "UNKNOWN";
    current = structuredClone(record);
    values.identity.textContent = `${record.asset.chainId} / ${record.asset.contract} / ${record.asset.tokenId}`;
    values.grounding.textContent = record.fresh
      ? record.grounding.state
      : "STALE";
    values.execution.textContent =
      record.execution.state + (record.fresh ? "" : " · 已保存状态，来源过期");
    values.reconciliation.textContent = record.reconciliation.state;
    values.recovery.textContent = record.recovery.state;
    const authority = record.grounding.mintAuthority ?? {
      status: "NOT_CHECKED",
    };
    const authorityText = [
      authority.status,
      authority.reason,
      "requested block " + (authority.requestedBlockNumber ?? "UNKNOWN"),
      authority.requestedBlockHash ?? "UNKNOWN",
    ]
      .filter(Boolean)
      .join(" · ");
    values.grounding.textContent += " · mint authority: " + authorityText;
    values.execution.textContent +=
      " · last new-action preflight (not current authority): " + authorityText;
    values.recovery.textContent +=
      current.recovery.state === "STOPPED"
        ? " · 已终止，未声称成交或对账成功"
        : " · historical reconciliation remains allowed";
    values.revocation.textContent = record.revocation.state;
    values.transaction.textContent = /^0x[0-9a-fA-F]{64}$/.test(
      record.execution.transactionHash ?? "",
    )
      ? record.execution.transactionHash
      : "UNKNOWN";
    values.observedAt.textContent = new Date(record.observedAt).toISOString();
  }
  async function action(work) {
    if (busy || !ready || disposed) return;
    busy = true;
    controls();
    notice.textContent = "处理中…";
    try {
      await work();
    } catch (error) {
      if (!disposed) {
        resetObservation();
        notice.textContent = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
          ? error.message
          : "DEPENDENCY_UNAVAILABLE · 状态未确认";
      }
    } finally {
      busy = false;
      if (!disposed) controls();
    }
  }
  async function load(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) stable("INTENT_ID_INVALID");
    resetObservation();
    const record = await methods.getIntent(id);
    if (disposed) return;
    show(record, id);
    notice.textContent = current.fresh
      ? "已读取服务端状态；历史铸造不代表当前可交易。"
      : "来源过期：显示已保存记录，不可据此新执行；仍可通过钱包撤销。";
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(async () => {
      draft = null;
      draftView.textContent = "尚无草案";
      const input = Object.fromEntries(
        Object.entries(inputs).map(([k, v]) => [k, v.value.trim()]),
      );
      if (
        !/^0x[0-9a-fA-F]{40}$/.test(input.contract) ||
        ["tokenId", "maxUnitPrice", "validUntil"].some(
          (k) => !/^(0|[1-9][0-9]*)$/.test(input[k]),
        )
      )
        stable("DRAFT_INPUT_INVALID");
      const result = validateDraft(await methods.prepareIntent(input));
      if (disposed) return;
      if (
        result.intent.maxUnitPrice !== input.maxUnitPrice ||
        result.intent.validUntil !== input.validUntil ||
        result.asset?.contract?.toLowerCase() !==
          input.contract.toLowerCase() ||
        result.asset?.tokenId !== input.tokenId ||
        String(result.asset?.chainId) !== "560048"
      )
        stable("DRAFT_INPUT_BINDING_MISMATCH");
      draft = result;
      draftView.textContent = JSON.stringify(
        {
          operationId: draft.operationId,
          asset: draft.asset,
          domain: draft.domain,
          intent: draft.intent,
        },
        null,
        2,
      );
      notice.textContent = "请核对全部授权字段后，用自己的钱包签名。";
    });
  });
  signButton.addEventListener("click", () => {
    void action(async () => {
      const frozen = validateDraft(draft);
      const signature = await sign(structuredClone(frozen));
      if (disposed) return;
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? ""))
        stable("WALLET_SIGNATURE_INVALID");
      draft = null; // An ambiguous create response must be looked up, not re-signed.
      selected.value = frozen.operationId; // Stable recovery ID exists before send.
      const created = await methods.createIntent({ ...frozen, signature });
      if (disposed) return;
      if (created?.id !== frozen.operationId)
        stable("CREATED_OPERATION_ID_MISMATCH");
      draft = null;
      selected.value = created.id;
      await load(created.id);
    });
  });
  refresh.addEventListener("click", () => {
    void action(() => load(selected.value.trim()));
  });
  revoke.addEventListener("click", () => {
    void action(async () => {
      if (!current || current.id !== selected.value.trim())
        stable("REVOCATION_CONTEXT_CHANGED");
      const snapshot = structuredClone(current);
      const result = await revokeNonce({
        id: snapshot.id,
        wallet: snapshot.intent.wallet,
        nonce: snapshot.intent.nonce,
        executor: snapshot.executor,
        chainId: "560048",
      });
      if (disposed) return;
      if (!/^0x[0-9a-fA-F]{64}$/.test(result?.transactionHash ?? ""))
        stable("REVOCATION_SUBMISSION_INVALID");
      await methods.recordRevocation(snapshot.id, result.transactionHash);
      if (disposed) return;
      current = null;
      values.revocation.textContent = "PENDING";
      notice.textContent = "撤销已提交，尚未确认；请刷新核对链上结果。";
    });
  });
  for (const input of Object.values(inputs))
    input.addEventListener("input", () => {
      if (!busy && draft) {
        draft = null;
        draftView.textContent = "输入已更改，请重新准备授权草案。";
        notice.textContent = "旧草案已失效，未签名。";
        controls();
      }
    });
  controls();
  if (ready) notice.textContent = "接口已接入；尚未读取状态。";
  return Object.freeze({
    dispose() {
      disposed = true;
      draft = null;
      current = null;
      root.replaceChildren();
    },
  });
}
