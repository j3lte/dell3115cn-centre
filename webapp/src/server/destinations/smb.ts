import { DeliveryError, ValidationError, type Destination } from "./types";

/** Retired: SMB profiles from older versions still load and show, but every use refuses with this message. */
export const SMB_RETIRED = "SMB is no longer supported; choose another destination";

export const smb: Destination<never> = {
  type: "smb",
  parse() {
    throw new ValidationError(SMB_RETIRED);
  },
  async test() {
    throw new DeliveryError(SMB_RETIRED);
  },
  async send() {
    throw new DeliveryError(SMB_RETIRED);
  },
};
