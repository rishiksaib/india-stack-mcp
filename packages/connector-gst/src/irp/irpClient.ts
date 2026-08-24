
import { createHash } from "node:crypto";

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

export class MockIrpClient implements IrpClient {
  private counter = 1000;

  async generateIrn(payloadJson: string): Promise<IrpResult> {
    this.counter += 1;
    const hash = createHash("sha256").update(payloadJson).digest("hex").slice(0, 40).toUpperCase();
    return {
      irn: `MOCK-${hash}-${this.counter}`,
      ackNo: String(Date.now()),
      ackDate: new Date().toISOString(),
      signedQrCode: undefined,
      irp: "mock"
    };
  }
}

export function irpFromEnv(): IrpClient {
  return new MockIrpClient();
}

