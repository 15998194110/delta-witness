const ENDPOINT = "https://store.agentexchange.work/mcp";
const TREASURY = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";

let session = "";

function parseMcp(text) {
  const body = text.trim();
  if (!body) return null;
  if (body.startsWith("{")) return JSON.parse(body);
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!data.length) throw new Error(`unparseable_mcp_response:${body.slice(0, 300)}`);
  return JSON.parse(data[data.length - 1]);
}

async function rpc(id, method, params = {}) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (session) headers["mcp-session-id"] = session;
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession) session = nextSession;
      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const error = new Error(`mcp_http_${response.status}:${text.slice(0, 500)}`);
        if (!retryable) throw error;
        last = error;
      } else {
        return parseMcp(text);
      }
    } catch (error) {
      last = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** (attempt - 1))));
  }
  throw last || new Error("mcp_request_failed");
}

function contentJson(result) {
  const text = result?.result?.content?.find((item) => item?.type === "text")?.text;
  if (!text) return null;
  return JSON.parse(text);
}

function classify(task) {
  const text = `${task?.title || ""} ${task?.spec || ""}`.toLowerCase();
  const hardExclusions = [
    "captcha", "recaptcha", "directory", "directories", "listing", "list ", "marketing",
    "write code", "coding", "deploy", "social media", "seo", "translation", "image generation",
  ];
  if (hardExclusions.some((term) => text.includes(term))) return null;

  if (/(guarded action|guarded-action|browser action|procurement|checkout|purchase|workflow safety)/.test(text)) {
    return { product: "guarded-action-pilot", price_usdc: 10 };
  }
  if (/(preflight|verify before|verification before|compare.*page|condition.*page|safe to act)/.test(text)) {
    return { product: "preflight", price_usdc: 5 };
  }
  if (/(page state|page-state|web evidence|website evidence|capture.*page|timestamped.*page|proof.*page|webpage proof)/.test(text)) {
    return { product: "capture", price_usdc: 1 };
  }
  return null;
}

try {
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "delta-witness-operator", version: "1.0.0" },
  });
  try { await rpc(null, "notifications/initialized", {}); } catch {}
  const toolsResult = await rpc(2, "tools/list", {});
  const tools = toolsResult?.result?.tools || [];
  const listTool = tools.find((tool) => tool.name === "market_list_tasks");
  const bidTool = tools.find((tool) => tool.name === "market_bid");
  if (!listTool || !bidTool) throw new Error("market_tools_missing");

  const openResult = await rpc(3, "tools/call", {
    name: "market_list_tasks",
    arguments: { status: "open" },
  });
  const payload = contentJson(openResult) || { count: 0, tasks: [] };
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const compatible = tasks.flatMap((task) => {
    const match = classify(task);
    if (!match) return [];
    const budget = Number(task?.budget_usdc);
    const funded = Number.isFinite(budget) && budget >= match.price_usdc;
    return [{
      task_id: task.id,
      title: task.title,
      buyer: task?.buyer?.name || null,
      buyer_pay_to: task?.buyer?.pay_to || null,
      budget_usdc: budget,
      bids: task?.bids ?? null,
      product: match.product,
      authorized_price_usdc: match.price_usdc,
      funded,
    }];
  });

  console.log(JSON.stringify({
    ok: true,
    channel: "agentexchange_clearing_house",
    listing_status: "not_applicable",
    discovery_status: "present",
    buyer_count: new Set(tasks.map((task) => task?.buyer?.name).filter(Boolean)).size,
    settlement_count: null,
    verified_neighbor_demand: tasks.length > 0,
    external_requests: tasks.length,
    intents_402: 0,
    paid_settlements: 0,
    treasury_received: 0,
    revenue: 0,
    variable_cost: 0,
    contribution_margin: 0,
    evidence_quality: "A_official_market_mcp",
    treasury: TREASURY,
    compatible_requests: compatible,
    funded_compatible_requests: compatible.filter((item) => item.funded),
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    channel: "agentexchange_clearing_house",
    discovery_status: "degraded_recoverable",
    error: error instanceof Error ? error.message : String(error),
    external_requests: null,
    funded_compatible_requests: [],
    evidence_quality: "C_channel_degraded",
    mutation: false,
  }, null, 2));
}
