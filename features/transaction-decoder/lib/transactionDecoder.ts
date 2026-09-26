import { encodeMuxedAccountToAddress, StrKey, xdr } from "@stellar/stellar-sdk";
import { err, ok, type Result } from "@/core/result/result";
import type { StellarNetwork as Network } from "@/core/network/types";
import type {
  DecodedOperation,
  DecodedTransactionResult,
  TransactionDecoderErrorCode
} from "@/features/transaction-decoder/types";
import type { TransactionDecoderInput } from "@/features/transaction-decoder/schema";

function formatMuxed(muxed: xdr.MuxedAccount): { address: string; isMuxed: boolean } {
  try {
    const address = encodeMuxedAccountToAddress(muxed, true);
    const isMuxed = address.startsWith("M");
    return { address, isMuxed };
  } catch {
    return { address: "Unknown", isMuxed: false };
  }
}

function decodeSingleOp(op: xdr.Operation, index: number): DecodedOperation {
  const body = op.body();
  const typeName = body.switch().name;
  // The SDK models this XDR union at runtime, but its generated declaration
  // omits the discriminant-specific accessors used after the switch above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value = body as any;
  let sourceAccount: string | null = null;
  const opSource = op.sourceAccount();
  if (opSource) {
    sourceAccount = formatMuxed(opSource).address;
  }

  let isCancelOffer = false;
  let isSponsorship = false;
  let isMuxedDestination = false;
  const labels: string[] = [typeName];
  const details: Record<string, string | number | boolean | null> = {};

  switch (typeName) {
    case "payment": {
      const p = value.payment();
      const dest = formatMuxed(p.destination());
      isMuxedDestination = dest.isMuxed;
      details["Destination"] = dest.address;
      details["Amount"] = p.amount().toString();
      details["Asset"] = p.asset().switch().name;
      break;
    }
    case "pathPaymentStrictReceive": {
      const p = value.pathPaymentStrictReceive();
      const dest = formatMuxed(p.destination());
      isMuxedDestination = dest.isMuxed;
      details["Destination"] = dest.address;
      details["DestAmount"] = p.destAmount().toString();
      details["SendMax"] = p.sendMax().toString();
      break;
    }
    case "pathPaymentStrictSend": {
      const p = value.pathPaymentStrictSend();
      const dest = formatMuxed(p.destination());
      isMuxedDestination = dest.isMuxed;
      details["Destination"] = dest.address;
      details["SendAmount"] = p.sendAmount().toString();
      details["DestMin"] = p.destMin().toString();
      break;
    }
    case "createAccount": {
      const c = value.createAccount();
      details["Destination"] = StrKey.encodeEd25519PublicKey(c.destination());
      details["StartingBalance"] = c.startingBalance().toString();
      break;
    }
    case "manageSellOffer": {
      const o = value.manageSellOffer();
      const amount = o.amount().toString();
      if (amount === "0") {
        isCancelOffer = true;
        labels.push("Cancel Offer");
      }
      details["OfferID"] = o.offerId().toString();
      details["Amount"] = amount;
      details["Price"] = `${o.price().n()}/${o.price().d()}`;
      break;
    }
    case "manageBuyOffer": {
      const o = value.manageBuyOffer();
      const amount = o.buyAmount().toString();
      if (amount === "0") {
        isCancelOffer = true;
        labels.push("Cancel Offer");
      }
      details["OfferID"] = o.offerId().toString();
      details["BuyAmount"] = amount;
      details["Price"] = `${o.price().n()}/${o.price().d()}`;
      break;
    }
    case "createPassiveSellOffer": {
      const o = value.createPassiveSellOffer();
      details["Amount"] = o.amount().toString();
      details["Price"] = `${o.price().n()}/${o.price().d()}`;
      break;
    }
    case "changeTrust": {
      const c = value.changeTrust();
      details["Limit"] = c.limit().toString();
      details["Asset"] = c.line().switch().name;
      break;
    }
    case "beginSponsoringFutureReserves": {
      isSponsorship = true;
      labels.push("Sponsorship");
      const b = value.beginSponsoringFutureReserves();
      details["SponsoredID"] = StrKey.encodeEd25519PublicKey(b.sponsoredId());
      break;
    }
    case "endSponsoringFutureReserves": {
      isSponsorship = true;
      labels.push("Sponsorship");
      details["Action"] = "End Sponsoring";
      break;
    }
    case "revokeSponsorship": {
      isSponsorship = true;
      labels.push("Sponsorship");
      details["Action"] = "Revoke Sponsorship";
      break;
    }
    default: {
      details["Type"] = typeName;
      break;
    }
  }

  if (isMuxedDestination) {
    labels.push("Muxed Destination");
  }

  return {
    index,
    type: typeName,
    sourceAccount,
    isCancelOffer,
    isSponsorship,
    isMuxedDestination,
    labels,
    details
  };
}

export function decodeEnvelope(
  input: TransactionDecoderInput,
  network: Network
): Result<DecodedTransactionResult, TransactionDecoderErrorCode> {
  let decoded: xdr.TransactionEnvelope;
  try {
    decoded = xdr.TransactionEnvelope.fromXDR(input.xdr, "base64");
  } catch {
    return err("malformed_xdr");
  }

  try {
    let sourceAccount = "";
    let sequence = "0";
    let fee = "0";
    const memo = { type: "none", value: null as string | null };
    let operationsRaw: xdr.Operation[] = [];
    let signatureCount = 0;
    const preconditions = {
      timeBounds: null as { minTime: string; maxTime: string } | null,
      ledgerBounds: null as { minLedger: number; maxLedger: number } | null,
      minSequenceNumber: null as string | null,
      minSequenceAge: null as string | null,
      minSequenceLedgerGap: null as number | null,
      extraSignerCount: 0
    };

    switch (decoded.switch().name) {
      case "envelopeTypeTxV0": {
        const tx = decoded.v0().tx();
        sourceAccount = StrKey.encodeEd25519PublicKey(tx.sourceAccountEd25519());
        sequence = tx.seqNum().toString();
        fee = tx.fee().toString();
        operationsRaw = tx.operations();
        signatureCount = decoded.v0().signatures().length;
        if (tx.timeBounds()) {
          preconditions.timeBounds = {
            minTime: tx.timeBounds()!.minTime().toString(),
            maxTime: tx.timeBounds()!.maxTime().toString()
          };
        }
        break;
      }
      case "envelopeTypeTx": {
        const tx = decoded.v1().tx();
        sourceAccount = formatMuxed(tx.sourceAccount()).address;
        sequence = tx.seqNum().toString();
        fee = tx.fee().toString();
        operationsRaw = tx.operations();
        signatureCount = decoded.v1().signatures().length;
        break;
      }
      case "envelopeTypeTxFeeBump": {
        const tx = decoded.feeBump().tx();
        const innerV1 = tx.innerTx().v1().tx();
        sourceAccount = formatMuxed(innerV1.sourceAccount()).address;
        sequence = innerV1.seqNum().toString();
        fee = tx.fee().toString();
        operationsRaw = innerV1.operations();
        signatureCount = decoded.feeBump().signatures().length;
        break;
      }
      default:
        return err("unsupported_envelope");
    }

    const operations = operationsRaw.map((op, i) => decodeSingleOp(op, i));

    return ok({
      sourceAccount,
      sequence,
      fee,
      memo,
      preconditions,
      signatureCount,
      operations,
      operationCount: operations.length,
      confidenceBadge: "static_analysis",
      network
    });
  } catch {
    return err("malformed_xdr");
  }
}
