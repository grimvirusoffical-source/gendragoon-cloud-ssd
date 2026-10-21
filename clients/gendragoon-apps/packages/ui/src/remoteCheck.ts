import { useEffect, useRef, useState } from "react";
import { makeUseRemoteCheck } from "./remoteCheckCore.js";

export { makeUseRemoteCheck, type HookSet, type RemoteCheckOptions } from "./remoteCheckCore.js";
/** The web/desktop binding; React Native builds its own with `makeUseRemoteCheck(React)`. */
export const useRemoteCheck = makeUseRemoteCheck({ useEffect, useRef, useState });
