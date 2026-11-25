/**
 * Multi-Actor Mutations Projection for Deterministic Replay (#423)
 *
 * Implements a multi-party settlement projection model covering:
 * - Ticket minting, multi-actor secondary transfers, fee splits and redemptions.
 * - Strict conservation of value (Buyer debit = Seller proceeds + Organizer fee + Protocol fee).
 * - Exact stroop integer math and monotonic nonces per actor.
 * - Invariant validation preventing negative balances or orphaned tickets.
 * - Upcasting from legacy v1 transfer events to v2 multi-actor fee-split events.
 */

import { err, ok, type Result } from "@/core/result/result";
import { createUpcasterRegistry, type UpcasterRegistry } from "./upcast";
import type { ProjectionDefinition, ReplayEvent } from "./types";

export type ActorRole = "organizer" | "buyer" | "seller" | "treasury" | "escrow";

export interface MultiActorAccount {
  readonly address: string;
  readonly balanceStroops: number;
  readonly role: ActorRole;
  readonly nonce: number;
}

export interface MultiActorTicket {
  readonly id: string;
  readonly eventId: string;
  readonly ownerAddress: string;
  readonly priceStroops: number;
  readonly status: "active" | "transferred" | "redeemed" | "burned";
  readonly transferCount: number;
}

export interface MultiActorMutationState {
  readonly accounts: Readonly<Record<string, MultiActorAccount>>;
  readonly tickets: Readonly<Record<string, MultiActorTicket>>;
  readonly totalProtocolFeesStroops: number;
  readonly totalOrganizerFeesStroops: number;
  readonly transfersCompleted: number;
  readonly redemptionsCompleted: number;
  readonly appliedEventIds: readonly string[];
  readonly lastSequence: number;
}

export interface AccountCreatedPayload {
  readonly address: string;
  readonly initialBalanceStroops: number;
  readonly role?: ActorRole;
}

export interface TicketMintedPayload {
  readonly ticketId: string;
  readonly eventId: string;
  readonly organizer: string;
  readonly buyer: string;
  readonly priceStroops: number;
}

export interface TicketTransferredV1Payload {
  readonly ticketId: string;
  readonly seller: string;
  readonly buyer: string;
  readonly price: string;
  readonly fee: string;
  readonly organizer?: string;
  readonly treasury?: string;
  readonly nonce?: number;
}

export interface TicketTransferredV2Payload {
  readonly ticketId: string;
  readonly seller: string;
  readonly buyer: string;
  readonly organizer: string;
  readonly treasury: string;
  readonly priceStroops: number;
  readonly organizerFeeStroops: number;
  readonly protocolFeeStroops: number;
  readonly sellerProceedsStroops: number;
  readonly nonce: number;
}

export interface TicketRedeemedPayload {
  readonly ticketId: string;
  readonly holder: string;
  readonly verifier: string;
  readonly timestamp: number;
}

export const multiActorUpcasters: UpcasterRegistry = createUpcasterRegistry([
  {
    type: "ticket.transferred",
    fromVersion: 1,
    upcast: (payload: unknown) => {
      const p = payload as TicketTransferredV1Payload;
      const priceStroops = Math.round(Number(p.price) * 10_000_000);
      const totalFeeStroops = Math.round(Number(p.fee) * 10_000_000);
      const protocolFeeStroops = Math.floor(totalFeeStroops / 2);
      const organizerFeeStroops = totalFeeStroops - protocolFeeStroops;
      const sellerProceedsStroops = priceStroops - totalFeeStroops;

      return {
        ticketId: p.ticketId,
        seller: p.seller,
        buyer: p.buyer,
        organizer: p.organizer ?? "G_ORGANIZER_DEFAULT",
        treasury: p.treasury ?? "G_TREASURY_DEFAULT",
        priceStroops,
        organizerFeeStroops,
        protocolFeeStroops,
        sellerProceedsStroops,
        nonce: p.nonce ?? 1
      } satisfies TicketTransferredV2Payload;
    }
  }
]);

export function initialMultiActorState(): MultiActorMutationState {
  return {
    accounts: {},
    tickets: {},
    totalProtocolFeesStroops: 0,
    totalOrganizerFeesStroops: 0,
    transfersCompleted: 0,
    redemptionsCompleted: 0,
    appliedEventIds: [],
    lastSequence: 0
  };
}

export function applyMultiActorMutation(
  state: MultiActorMutationState,
  event: ReplayEvent
): MultiActorMutationState {
  const appliedEventIds = [...state.appliedEventIds, event.id];
  const lastSequence = event.sequence;

  if (event.type === "account.created") {
    const payload = event.payload as AccountCreatedPayload;
    if (payload.initialBalanceStroops < 0) {
      throw new Error(`account.created: negative initial balance for ${payload.address}`);
    }
    const accounts = {
      ...state.accounts,
      [payload.address]: {
        address: payload.address,
        balanceStroops: payload.initialBalanceStroops,
        role: payload.role ?? "buyer",
        nonce: 0
      }
    };
    return { ...state, accounts, appliedEventIds, lastSequence };
  }

  if (event.type === "ticket.minted") {
    const p = event.payload as TicketMintedPayload;
    const buyer = state.accounts[p.buyer];
    const organizer = state.accounts[p.organizer];
    if (!buyer) throw new Error(`ticket.minted: unknown buyer ${p.buyer}`);
    if (!organizer) throw new Error(`ticket.minted: unknown organizer ${p.organizer}`);
    if (buyer.balanceStroops < p.priceStroops) {
      throw new Error(`ticket.minted: insufficient balance for buyer ${p.buyer}`);
    }

    const accounts = {
      ...state.accounts,
      [p.buyer]: {
        ...buyer,
        balanceStroops: buyer.balanceStroops - p.priceStroops,
        nonce: buyer.nonce + 1
      },
      [p.organizer]: {
        ...organizer,
        balanceStroops: organizer.balanceStroops + p.priceStroops
      }
    };

    const tickets = {
      ...state.tickets,
      [p.ticketId]: {
        id: p.ticketId,
        eventId: p.eventId,
        ownerAddress: p.buyer,
        priceStroops: p.priceStroops,
        status: "active" as const,
        transferCount: 0
      }
    };

    return { ...state, accounts, tickets, appliedEventIds, lastSequence };
  }

  if (event.type === "ticket.transferred") {
    const p = event.payload as TicketTransferredV2Payload;
    const ticket = state.tickets[p.ticketId];
    if (!ticket) throw new Error(`ticket.transferred: ticket ${p.ticketId} does not exist`);
    if (ticket.status !== "active" && ticket.status !== "transferred") {
      throw new Error(`ticket.transferred: ticket ${p.ticketId} is not in transferable status (${ticket.status})`);
    }
    if (ticket.ownerAddress !== p.seller) {
      throw new Error(`ticket.transferred: seller ${p.seller} is not owner of ticket ${p.ticketId}`);
    }

    // Conservation invariant
    const splitSum = p.sellerProceedsStroops + p.organizerFeeStroops + p.protocolFeeStroops;
    if (splitSum !== p.priceStroops) {
      throw new Error(`ticket.transferred: fee split mismatch (${splitSum} != ${p.priceStroops})`);
    }

    const seller = state.accounts[p.seller];
    const buyer = state.accounts[p.buyer];
    const organizer = state.accounts[p.organizer];
    const treasury = state.accounts[p.treasury];

    if (!seller) throw new Error(`ticket.transferred: seller ${p.seller} not found`);
    if (!buyer) throw new Error(`ticket.transferred: buyer ${p.buyer} not found`);
    if (!organizer) throw new Error(`ticket.transferred: organizer ${p.organizer} not found`);
    if (!treasury) throw new Error(`ticket.transferred: treasury ${p.treasury} not found`);

    if (buyer.balanceStroops < p.priceStroops) {
      throw new Error(`ticket.transferred: buyer ${p.buyer} balance (${buyer.balanceStroops}) < price (${p.priceStroops})`);
    }

    const accounts = {
      ...state.accounts,
      [p.buyer]: {
        ...buyer,
        balanceStroops: buyer.balanceStroops - p.priceStroops,
        nonce: buyer.nonce + 1
      },
      [p.seller]: {
        ...seller,
        balanceStroops: seller.balanceStroops + p.sellerProceedsStroops,
        nonce: seller.nonce + 1
      },
      [p.organizer]: {
        ...organizer,
        balanceStroops: organizer.balanceStroops + p.organizerFeeStroops
      },
      [p.treasury]: {
        ...treasury,
        balanceStroops: treasury.balanceStroops + p.protocolFeeStroops
      }
    };

    const tickets = {
      ...state.tickets,
      [p.ticketId]: {
        ...ticket,
        ownerAddress: p.buyer,
        status: "transferred" as const,
        transferCount: ticket.transferCount + 1
      }
    };

    return {
      ...state,
      accounts,
      tickets,
      totalProtocolFeesStroops: state.totalProtocolFeesStroops + p.protocolFeeStroops,
      totalOrganizerFeesStroops: state.totalOrganizerFeesStroops + p.organizerFeeStroops,
      transfersCompleted: state.transfersCompleted + 1,
      appliedEventIds,
      lastSequence
    };
  }

  if (event.type === "ticket.redeemed") {
    const p = event.payload as TicketRedeemedPayload;
    const ticket = state.tickets[p.ticketId];
    if (!ticket) throw new Error(`ticket.redeemed: ticket ${p.ticketId} does not exist`);
    if (ticket.ownerAddress !== p.holder) {
      throw new Error(`ticket.redeemed: holder ${p.holder} does not own ticket ${p.ticketId}`);
    }
    if (ticket.status === "redeemed") {
      throw new Error(`ticket.redeemed: ticket ${p.ticketId} already redeemed`);
    }

    const tickets = {
      ...state.tickets,
      [p.ticketId]: {
        ...ticket,
        status: "redeemed" as const
      }
    };

    return {
      ...state,
      tickets,
      redemptionsCompleted: state.redemptionsCompleted + 1,
      appliedEventIds,
      lastSequence
    };
  }

  // Unhandled event type ignored
  return { ...state, appliedEventIds, lastSequence };
}

export function validateMultiActorMutationState(state: MultiActorMutationState): readonly string[] {
  const violations: string[] = [];

  for (const [address, account] of Object.entries(state.accounts)) {
    if (account.balanceStroops < 0) {
      violations.push(`negative balance for account ${address}: ${account.balanceStroops}`);
    }
    if (account.nonce < 0) {
      violations.push(`negative nonce for account ${address}: ${account.nonce}`);
    }
  }

  for (const [id, ticket] of Object.entries(state.tickets)) {
    if (!state.accounts[ticket.ownerAddress]) {
      violations.push(`ticket ${id} owner ${ticket.ownerAddress} does not exist`);
    }
    if (ticket.priceStroops < 0) {
      violations.push(`negative price for ticket ${id}: ${ticket.priceStroops}`);
    }
  }

  if (state.totalProtocolFeesStroops < 0) {
    violations.push(`negative total protocol fees: ${state.totalProtocolFeesStroops}`);
  }
  if (state.totalOrganizerFeesStroops < 0) {
    violations.push(`negative total organizer fees: ${state.totalOrganizerFeesStroops}`);
  }

  return violations;
}

export function createMultiActorProjection(
  version = 1,
  appliedEventsLog?: string[]
): ProjectionDefinition<MultiActorMutationState> {
  return {
    name: "multi-actor-settlement",
    version,
    eventVersions: {
      "account.created": 1,
      "ticket.minted": 1,
      "ticket.transferred": 2,
      "ticket.redeemed": 1
    },
    initial: initialMultiActorState,
    apply: (state, event) => {
      appliedEventsLog?.push(event.id);
      return applyMultiActorMutation(state, event);
    },
    validate: validateMultiActorMutationState
  };
}

/**
 * Pure serial fold of multi-actor events for test assertions.
 */
export function expectedMultiActorState(
  events: readonly ReplayEvent[],
  upcasters: UpcasterRegistry = multiActorUpcasters
): MultiActorMutationState {
  let state = initialMultiActorState();
  for (const event of events) {
    const upcastRes = upcasters.upcast(event, 2);
    const finalEvent = upcastRes.ok ? upcastRes.value : event;
    state = applyMultiActorMutation(state, finalEvent);
  }
  return state;
}
