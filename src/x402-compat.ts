function decodePaymentRequired(value: string): Record<string, unknown> | null {
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Mirror the canonical Payment-Required header into the JSON body of an unpaid
 * 402 response. Some buyer/registry probes inspect only the body even though
 * x402 v2 defines the Payment-Required header as canonical. Keeping both
 * representations identical broadens compatibility without changing payment
 * terms or settlement behavior.
 */
export function mirrorX402ChallengeBody(
  response: Response,
  extra: Record<string, unknown> = {},
): Response {
  if (response.status !== 402) return response;
  const encoded = response.headers.get("payment-required");
  if (!encoded) return response;
  const challenge = decodePaymentRequired(encoded);
  if (!challenge) return response;

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "private, no-store");
  return new Response(JSON.stringify({ ...challenge, ...extra }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
