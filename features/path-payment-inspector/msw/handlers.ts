import { http, HttpResponse } from "msw";
import { offersResponse, pathsResponse, poolOnlyResponse } from "@/features/path-payment-inspector/fixtures/pathPaymentInspector.fixture";

const base = "https://horizon-testnet.stellar.org";
export const handlers = [
  http.get(`${base}/accounts/:account/offers`, () => HttpResponse.json(offersResponse)),
  http.get(`${base}/paths/strict-send`, () => HttpResponse.json(pathsResponse)),
  http.get(`${base}/paths/strict-receive`, () => HttpResponse.json(pathsResponse))
];
export const poolOnlyHandler = http.get(`${base}/paths/strict-receive`, () => HttpResponse.json(poolOnlyResponse));
