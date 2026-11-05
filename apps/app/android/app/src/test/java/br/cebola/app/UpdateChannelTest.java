package br.cebola.app;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class UpdateChannelTest {
    @Test
    public void projectorUsesArm32ManifestAndApk() {
        assertEquals("https://updates.example.invalid/downloads/cebola-android-arm32-latest.json", UpdateChannel.manifestUrl(false));
        assertEquals("https://updates.example.invalid/downloads/cebola-release-arm32.apk", UpdateChannel.apkUrl(false));
    }

    @Test
    public void phoneKeepsExistingArm64Channel() {
        assertEquals("https://updates.example.invalid/downloads/cebola-android-latest.json", UpdateChannel.manifestUrl(true));
        assertEquals("https://updates.example.invalid/downloads/cebola-release.apk", UpdateChannel.apkUrl(true));
    }
}
