/* global process, module */
/** NSIS signing is opt-in through the environment. An empty value leaves the installer unsigned. */
function signingFromEnv(env = process.env) {
  const certificateFile = env.GENDRAGOON_NSIS_CERT || env.WIN_CSC_LINK || env.CSC_LINK || "";
  const certificatePassword = env.GENDRAGOON_NSIS_CERT_PASSWORD || env.WIN_CSC_KEY_PASSWORD || env.CSC_KEY_PASSWORD || "";
  return {
    enabled: Boolean(certificateFile),
    certificateFile,
    certificatePassword,
  };
}

module.exports = { signingFromEnv };
