"use client";

import { useCallback, useRef, useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import type { StellarNetwork } from "@/core/network/types";
import { isErr } from "@/core/result/result";
import { FIELD_OF_CODE, parseOperationBrowserInput } from "@/features/operation-browser/schema";
import { useNotifications } from "@/core/notifications/NotificationProvider";
import { copy, errorCopy } from "@/features/operation-browser/copy";
import {
  loadNewerOperationPage,
  loadOlderOperationPage,
  runOperationBrowser
} from "@/features/operation-browser/lib/operationBrowser";
import type {
  OperationBrowserErrorCode,
  OperationBrowserField,
  OperationBrowserResult
} from "@/features/operation-browser/types";

export type OperationBrowserState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: OperationBrowserResult; paging: "idle" | "older" | "newer" }
  | { status: "error"; code: OperationBrowserErrorCode; field: OperationBrowserField | null };

const IDLE: OperationBrowserState = { status: "idle" };

interface Held {
  state: OperationBrowserState;
  network: StellarNetwork;
}

export function useOperationBrowser() {
  const { network } = useNetwork();
  const [held, setHeld] = useState<Held>({ state: IDLE, network });
  const controller = useRef<AbortController | null>(null);
  const lastSubmittedAccount = useRef<string | null>(null);
  const lastFailedAccount = useRef<string | null>(null);
  const { publish } = useNotifications();

  const state = held.network === network ? held.state : IDLE;

  const submit = useCallback(
    async (raw: string) => {
      controller.current?.abort();
      const parsed = parseOperationBrowserInput(raw);

      if (isErr(parsed)) {
        setHeld({
          state: { status: "error", code: parsed.code, field: FIELD_OF_CODE[parsed.code] },
          network
        });
        return;
      }

      lastSubmittedAccount.current = parsed.value.accountId;
      const next = new AbortController();
      controller.current = next;
      setHeld({ state: { status: "loading" }, network });

      const result = await runOperationBrowser(parsed.value, network, next.signal);
      if (next.signal.aborted) return;

      if (result.ok) {
        const recovered = lastFailedAccount.current === parsed.value.accountId;
        publish({
          recipient: `account:${parsed.value.accountId}`,
          event: recovered ? "recovery" : "completed",
          tone: "success",
          title: recovered ? copy.notificationRecoveryTitle : copy.notificationCompletedTitle,
          message: recovered
            ? copy.notificationRecoveryMessage
            : copy.notificationCompletedMessage(result.value.pages[0]?.length ?? 0),
          href: copy.notificationHref(parsed.value.accountId),
          dedupeKey: `operation-browser:${recovered ? "recovery" : "completed"}:${network}:${parsed.value.accountId}`
        });
        if (recovered) lastFailedAccount.current = null;
        setHeld({ state: { status: "success", result: result.value, paging: "idle" }, network });
        return;
      }

      lastFailedAccount.current = parsed.value.accountId;
      publish({
        recipient: `account:${parsed.value.accountId}`,
        event: "failure",
        tone: "error",
        title: copy.notificationFailureTitle,
        message: copy.notificationFailureMessage(errorCopy[result.code].title),
        href: copy.notificationHref(parsed.value.accountId),
        dedupeKey: `operation-browser:failure:${network}:${parsed.value.accountId}:${result.code}`
      });
      setHeld({
        state: { status: "error", code: result.code, field: FIELD_OF_CODE[result.code] },
        network
      });
    },
    [network, publish]
  );

  const loadOlder = useCallback(async () => {
    if (state.status !== "success") return;

    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setHeld({
      state: { ...state, paging: "older" },
      network
    });

    const result = await loadOlderOperationPage(state.result, network, next.signal);
    if (next.signal.aborted) return;

    if (result.ok) {
      publish({
        recipient: `account:${state.result.accountId}`,
        event: "completed",
        tone: "success",
        title: copy.notificationCompletedTitle,
        message: copy.notificationCompletedMessage(result.value.pages.at(-1)?.length ?? 0),
        href: copy.notificationHref(state.result.accountId),
        dedupeKey: `operation-browser:completed:${network}:${state.result.accountId}:${result.value.pageIndex}`
      });
      if (lastFailedAccount.current === state.result.accountId) lastFailedAccount.current = null;
      setHeld({ state: { status: "success", result: result.value, paging: "idle" }, network });
      return;
    }

    lastFailedAccount.current = state.result.accountId;
    publish({
      recipient: `account:${state.result.accountId}`,
      event: "failure",
      tone: "error",
      title: copy.notificationFailureTitle,
      message: copy.notificationFailureMessage(errorCopy[result.code].title),
      href: copy.notificationHref(state.result.accountId),
      dedupeKey: `operation-browser:failure:${network}:${state.result.accountId}:older:${result.code}`
    });
    setHeld({
      state: { status: "error", code: result.code, field: FIELD_OF_CODE[result.code] },
      network
    });
  }, [network, publish, state]);

  const loadNewer = useCallback(() => {
    if (state.status !== "success" || state.result.pageIndex === 0) return;
    setHeld({
      state: {
        status: "success",
        result: loadNewerOperationPage(state.result),
        paging: "newer"
      },
      network
    });
  }, [network, state]);

  const setTypeFilter = useCallback(
    (typeFilter: string) => {
      if (state.status !== "success") return;
      setHeld({
        state: {
          status: "success",
          result: { ...state.result, typeFilter },
          paging: "idle"
        },
        network
      });
    },
    [network, state]
  );

  const retry = useCallback(async () => {
    const accountId = lastSubmittedAccount.current;
    if (!accountId) return;
    publish({
      recipient: `account:${accountId}`,
      event: "retry",
      tone: "info",
      title: copy.notificationRetryTitle,
      message: copy.notificationRetryMessage,
      href: copy.notificationHref(accountId),
      dedupeKey: `operation-browser:retry:${network}:${accountId}`
    });
    await submit(accountId);
  }, [network, publish, submit]);

  const reset = useCallback(() => {
    controller.current?.abort();
    lastSubmittedAccount.current = null;
    lastFailedAccount.current = null;
    setHeld({ state: IDLE, network });
  }, [network]);

  return { state, submit, loadOlder, loadNewer, setTypeFilter, retry, reset };
}
