const USER_AGENT =
  "SLT-MutualAid-JobBoard/1.0 (+https://github.com/slt-mutual-aid/job-board)";
const TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 1000;

type Attempt =
  | { ok: true; body: string }
  | { ok: false; retryable: boolean; error: Error };

// A 4xx other than 429 describes the request itself, so repeating it produces
// the same answer and only costs the remote host another round trip.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function attempt(url: string): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, retryable: true, error: error as Error };
  }

  if (!response.ok) {
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      error: new Error(`GET ${url} returned HTTP ${response.status}`),
    };
  }

  return { ok: true, body: await response.text() };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchText(url: string): Promise<string> {
  const first = await attempt(url);
  if (first.ok) {
    return first.body;
  }
  if (!first.retryable) {
    throw first.error;
  }

  await delay(RETRY_DELAY_MS);

  const second = await attempt(url);
  if (second.ok) {
    return second.body;
  }
  throw second.error;
}
