export type DifferentialPrivacyConfig = {
  dpEnabled: boolean;
  epsilon: number;
};

export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
}

export function applyDifferentialPrivacy(
  _value: number,
  _config: DifferentialPrivacyConfig,
): never {
  throw new NotImplementedError("DP noise not enabled for pilot");
}

