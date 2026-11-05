package br.cebola.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class PlayerOrientationSessionTest {
    @Test
    public void keepsPortraitOriginAcrossMediaReplacement() {
        PlayerOrientationSession session = new PlayerOrientationSession();
        session.captureIfNeeded(-1, -1, true, 12);
        session.captureIfNeeded(6, -1, false, 12);

        assertEquals(Integer.valueOf(12), session.finish());
        assertNull(session.finish());
    }

    @Test
    public void preservesExplicitOriginalOrientation() {
        PlayerOrientationSession session = new PlayerOrientationSession();
        session.captureIfNeeded(0, -1, false, 12);

        assertEquals(Integer.valueOf(0), session.finish());
    }
}
