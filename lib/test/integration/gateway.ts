// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The subsidised-gateway half of the integration harness.
 *
 * Subsidised mode is the one upload path the library does not stamp itself: it
 * POSTs bare chunks and SOCs to a gateway that injects `swarm-postage-batch-id`
 * server-side. That contract lives entirely in HTTP requests this repo does not
 * control, so a mock of it is a mock of someone else's server — it cannot drift
 * into disagreement and tell us. Here the real thing runs: upstream's
 * `gateway-proxy`, in a container, in front of the same bee-compose queen the
 * stamper-mode tests use.
 *
 * Started once from `global-setup.ts` and torn down with the run. Reaching that
 * start means the cluster answered, and bee-compose IS Docker — so a gateway
 * that will not come up is a real breakage, and the setup fails the run instead
 * of skipping. Nothing in this suite skips.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { UploadTarget } from "../../src/proxy/upload"
import { QUEEN_URL } from "./cluster"

const run = promisify(execFile)

/**
 * `docker run` pulls the image when it is missing — a cold CI runner fetching
 * ~106 MB — and every layer line lands in this buffer. The default 1 MB is
 * probably enough and failing on it would look like a broken gateway rather
 * than a full pipe, which is not a debugging session worth having.
 */
const DOCKER_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Pinned rather than `latest`: the image publishes no `latest` tag, and a
 * gateway that changes under the suite would move the contract being pinned.
 */
const GATEWAY_IMAGE = "ethersphere/gateway-proxy:0.17.0"
const GATEWAY_CONTAINER = "swarm-id-gateway-proxy"

/** The port gateway-proxy listens on inside the container (its default). */
const GATEWAY_CONTAINER_PORT = 3000
/**
 * Host port. Deliberately not 3000 — that collides with half the dev servers on
 * a typical machine — and adjacent to the demo's 3500 so it reads as ours.
 */
const GATEWAY_PORT = 3600
export const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`

const HTTP_OK = 200
const GATEWAY_START_TIMEOUT_MS = 60_000
const GATEWAY_POLL_INTERVAL_MS = 500
const REACHABLE_TIMEOUT_MS = 2000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Whether the container is answering yet — the start's own readiness poll. */
async function isGatewayReachable(url: string = GATEWAY_URL): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS),
    })
    return response.status === HTTP_OK
  } catch {
    return false
  }
}

/** Subsidised-mode upload target, the counterpart to `createClusterContext`. */
export function createSubsidisedTarget(
  gatewayUrl: string = GATEWAY_URL,
): UploadTarget {
  return { mode: "subsidised", gatewayUrl }
}

async function removeExistingContainer(): Promise<void> {
  try {
    await run("docker", ["rm", "-f", GATEWAY_CONTAINER], {
      maxBuffer: DOCKER_MAX_BUFFER,
    })
  } catch {
    // No such container, which is the normal case.
  }
}

/**
 * Start `gateway-proxy` in front of the queen, stamping with `batchId`.
 *
 * `POSTAGE_STAMP` rather than the image's autobuy: the batch the suite already
 * bought and warmed is the one the stamper-mode tests use, so both modes write
 * against the same batch and a failure cannot be blamed on a second, colder one.
 *
 * Returns `undefined` when Docker cannot run it, having warned why; the caller
 * turns that into a failed run rather than a skipped suite. Anything past a
 * healthy container (a stamp the gateway will not use, an endpoint it no longer
 * proxies) is left to fail in the tests, where the reason is visible.
 */
export async function startGatewayProxy(
  batchId: string,
): Promise<{ url: string; stop: () => Promise<void> } | undefined> {
  await removeExistingContainer()

  try {
    await run(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        GATEWAY_CONTAINER,
        "-p",
        `${GATEWAY_PORT}:${GATEWAY_CONTAINER_PORT}`,
        // The queen publishes 1633 on the host, and the gateway has to reach it
        // from inside its own network namespace. `host-gateway` is what makes
        // `host.docker.internal` resolve on Linux CI as well as Docker Desktop.
        "--add-host=host.docker.internal:host-gateway",
        "-e",
        `BEE_API_URL=${QUEEN_URL.replace("localhost", "host.docker.internal")}`,
        "-e",
        `POSTAGE_STAMP=${batchId}`,
        "-e",
        "LOG_LEVEL=warn",
        GATEWAY_IMAGE,
      ],
      { maxBuffer: DOCKER_MAX_BUFFER },
    )
  } catch (error) {
    console.warn(
      `[gateway] Could not start ${GATEWAY_IMAGE}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }

  const deadline = Date.now() + GATEWAY_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isGatewayReachable()) {
      return { url: GATEWAY_URL, stop: removeExistingContainer }
    }
    await delay(GATEWAY_POLL_INTERVAL_MS)
  }

  console.warn(
    `[gateway] ${GATEWAY_IMAGE} did not answer /health within ${GATEWAY_START_TIMEOUT_MS}ms`,
  )
  await removeExistingContainer()
  return undefined
}
