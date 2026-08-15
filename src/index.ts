import "dotenv/config"
import Cloudflare from "cloudflare"

// Regex pattern for validating IPv4 addresses
const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/

function isValidIPv4(ip: string): boolean {
  return IPV4_REGEX.test(ip.trim())
}

// IP provider endpoints for multi-provider fallback
const IP_PROVIDERS = [
  "https://api.ipify.org?format=json",
  "https://ipinfo.io/json",
  "https://api.myip.com",
]

/**
 * Fetches the current public IPv4 address with fallback providers and timeout handling.
 */
async function fetchPublicIPv4(): Promise<string> {
  for (const url of IP_PROVIDERS) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 8000)

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        continue
      }

      const data = (await response.json()) as { ip?: string }
      if (data && typeof data.ip === "string" && isValidIPv4(data.ip)) {
        return data.ip.trim()
      }
    } catch {
      // Silently try next provider on timeout or network error
      continue
    }
  }

  throw new Error("Failed to detect a valid public IPv4 address from all providers.")
}

async function runDDNSCheck(): Promise<void> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const zoneId = process.env.CLOUDFLARE_ZONE_ID
  const dnsRecordId = process.env.CLOUDFLARE_DNS_RECORD_ID
  const dnsRecordName = process.env.CLOUDFLARE_DNS_RECORD_NAME

  if (!apiToken || !zoneId || !dnsRecordId || !dnsRecordName) {
    console.error("[DDNS] Error: Missing required environment variables. Please check .env configuration.")
    console.error("[DDNS] Required: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, CLOUDFLARE_DNS_RECORD_ID, CLOUDFLARE_DNS_RECORD_NAME")
    return
  }

  try {
    // 1. Detect public IPv4
    const currentPublicIp = await fetchPublicIPv4()
    console.log(`[DDNS] Current public IP: ${currentPublicIp}`)

    // 2. Initialize Cloudflare client
    const cf = new Cloudflare({ apiToken })

    // 3. Fetch existing DNS record from Cloudflare
    let existingRecordContent = ""
    try {
      // Cloudflare SDK DNS records get method
      const record = await cf.dns.records.get(dnsRecordId, { zone_id: zoneId })
      existingRecordContent = record.content || ""
    } catch (err: any) {
      console.error(`[DDNS] Failed to fetch Cloudflare DNS record (${dnsRecordId}): ${err?.message || err}`)
      return
    }

    console.log(`[DDNS] Cloudflare record IP: ${existingRecordContent}`)

    // 4. Compare current IP with Cloudflare record
    if (currentPublicIp === existingRecordContent) {
      console.log("[DDNS] IP unchanged - no update required")
      return
    }

    // 5. Update Cloudflare DNS record if IP has changed
    console.log("[DDNS] Public IP changed")
    console.log("[DDNS] Updating Cloudflare DNS record")

    await cf.dns.records.edit(dnsRecordId, {
      zone_id: zoneId,
      content: currentPublicIp,
      name: dnsRecordName,
      type: "A",
      ttl: 1,
    })

    console.log("[DDNS] DNS record updated successfully")
  } catch (err: any) {
    console.error(`[DDNS] Unexpected error during DDNS update loop: ${err?.message || err}`)
  }
}

async function main(): Promise<void> {
  const dnsRecordName = process.env.CLOUDFLARE_DNS_RECORD_NAME || "unconfigured"
  const rawInterval = process.env.DDNS_INTERVAL_SECONDS
  const intervalSeconds = Math.max(10, parseInt(rawInterval || "300", 10) || 300)

  console.log("[DDNS] Cloudflare DDNS updater started")
  console.log(`[DDNS] Target record: ${dnsRecordName}`)
  console.log(`[DDNS] Update interval: ${intervalSeconds} seconds`)

  // Initial check on startup
  await runDDNSCheck()

  // Recurring loop
  const intervalId = setInterval(() => {
    runDDNSCheck().catch((err) => {
      console.error(`[DDNS] Unhandled interval error: ${err?.message || err}`)
    })
  }, intervalSeconds * 1000)

  // Graceful shutdown handlers
  const shutdown = () => {
    console.log("[DDNS] Shutting down DDNS updater...")
    clearInterval(intervalId)
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error(`[DDNS] Fatal startup error: ${err?.message || err}`)
  process.exit(1)
})
