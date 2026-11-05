package br.cebola.app;

/** Select by the installed process ABI, including 32-bit APKs on 64-bit hardware. */
final class UpdateChannel {
    private static final String DOWNLOADS = "https://updates.example.invalid/downloads/";

    static String manifestUrl(boolean process64Bit) {
        return DOWNLOADS + (process64Bit ? "cebola-android-latest.json" : "cebola-android-arm32-latest.json");
    }

    static String apkUrl(boolean process64Bit) {
        return DOWNLOADS + (process64Bit ? "cebola-release.apk" : "cebola-release-arm32.apk");
    }
}
