import { createHash } from "node:crypto";
import { ConnectorError, ErrorCode } from "@india-stack/core";

export interface IrpResult {
  irn: string;
  ackNo: string;
  ackDate: string;
  signedQrCode?: string;
  irp: "mock" | "nic" | "gsp";
}

export interface IrpClient {
  generateIrn(payloadJson: string): Promise<IrpResult>;
}

/** Test double. Its IRNs start with "MOCK-" and are not legal documents. */
export class MockIrpClient implements IrpClient {
  private counter = 1000;

  async generateIrn(payloadJson: string): Promise<IrpResult> {
    this.counter += 1;
    const hash = createHash("sha256").update(payloadJson).digest("hex").slice(0, 40).toUpperCase();
    return {
      irn: `MOCK-${hash}-${this.counter}`,
      ackNo: `MOCK-${Date.now()}`,
      ackDate: new Date().toISOString(),
      signedQrCode: undefined,
      irp: "mock"
    };
  }
}

/**
 * No licensed IRP/GSP integration ships with this package. Live generation is refused unless
 * INDIA_STACK_IRP=mock is set explicitly (for demos and tests), so an agent can never present
 * a synthetic IRN as a real one.
 */
export function irpFromEnv(): IrpClient {
  if ((process.env.INDIA_STACK_IRP ?? "").toLowerCase() === "mock") return new MockIrpClient();
  throw new ConnectorError(
    ErrorCode.ValidationError,
    "No IRP/GSP client is configured, so a real IRN cannot be generated. Use gst_einvoice_build (or dry-run) to produce the schema v1.1 JSON and upload it through the e-invoice portal or your GSP."
  );
}
