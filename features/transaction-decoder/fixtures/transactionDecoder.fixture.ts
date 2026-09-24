import type { DecodedTransactionResult } from "@/features/transaction-decoder/types";

export const transactionDecoderFixture: DecodedTransactionResult = {
  sourceAccount: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
  sequence: "100523",
  fee: "100",
  memo: { type: "none", value: null },
  preconditions: {
    timeBounds: null,
    ledgerBounds: null,
    minSequenceNumber: null,
    minSequenceAge: null,
    minSequenceLedgerGap: null,
    extraSignerCount: 0
  },
  signatureCount: 1,
  operations: [
    {
      index: 0,
      type: "payment",
      sourceAccount: null,
      isCancelOffer: false,
      isSponsorship: false,
      isMuxedDestination: false,
      labels: ["payment"],
      details: { Destination: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCMA44", Amount: "10000000", Asset: "native" }
    },
    {
      index: 1,
      type: "manageSellOffer",
      sourceAccount: null,
      isCancelOffer: true,
      isSponsorship: false,
      isMuxedDestination: false,
      labels: ["manageSellOffer", "Cancel Offer"],
      details: { OfferID: "12345", Amount: "0", Price: "1/1" }
    },
    {
      index: 2,
      type: "beginSponsoringFutureReserves",
      sourceAccount: null,
      isCancelOffer: false,
      isSponsorship: true,
      isMuxedDestination: false,
      labels: ["beginSponsoringFutureReserves", "Sponsorship"],
      details: { SponsoredID: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCMA44" }
    }
  ],
  operationCount: 3,
  confidenceBadge: "static_analysis",
  network: "testnet"
};
