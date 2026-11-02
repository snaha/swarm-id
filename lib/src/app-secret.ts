// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A secret the app asked for with `client.deriveAppSecret(label)` (#889),
 * without the bytes: the proxy derives `HMAC(appSecret, label)` whenever the
 * handle is used — as a feed topic or a signer — so nothing secret sits in
 * the page to be logged, serialized or exfiltrated. The handle is the label,
 * so it is the same after a reload and on another device, and the proxy keeps
 * no table.
 *
 * `reveal()` hands the bytes out after all; the proxy answers only when the
 * user granted the `revealSecrets` permission.
 */
export class AppSecret {
  constructor(
    readonly label: string,
    private readonly revealer: (label: string) => Promise<Uint8Array>,
  ) {}

  /** The 32 derived bytes; rejects with `permission-denied` unless `revealSecrets` is granted */
  reveal(): Promise<Uint8Array> {
    return this.revealer(this.label)
  }

  /** What the proxy needs to derive it */
  toRef(): { derived: string } {
    return { derived: this.label }
  }

  toJSON(): string {
    return this.toString()
  }

  toString(): string {
    return `AppSecret(${this.label})`
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString()
  }
}
