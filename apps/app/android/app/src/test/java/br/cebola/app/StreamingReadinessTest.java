package br.cebola.app;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static br.cebola.app.StreamingReadiness.Decision.*;

public class StreamingReadinessTest {
    private static final long MIB = 1024L * 1024;

    @Test public void metadataAloneDoesNotOpenPlayer() {
        assertEquals(WAIT, StreamingReadiness.evaluate(100 * MIB, 0, 0, 0));
        assertEquals(WAIT, StreamingReadiness.evaluate(100 * MIB, 8 * MIB - 1, 0, 19_999));
        assertEquals(TOO_SLOW, StreamingReadiness.evaluate(100 * MIB, 0, 0, 20_000));
    }

    @Test public void downloadedBufferOrCompleteSmallFileOpensImmediately() {
        assertEquals(READY, StreamingReadiness.evaluate(100 * MIB, 8 * MIB, 0, 200));
        assertEquals(WAIT, StreamingReadiness.evaluate(MIB, MIB - 1, 0, 200));
        assertEquals(READY, StreamingReadiness.evaluate(MIB, MIB, 0, 200));
    }

    @Test public void speedFallbackOnlyAppliesAfterObservationWindow() {
        assertEquals(WAIT, StreamingReadiness.evaluate(100 * MIB, MIB, MIB, 19_999));
        assertEquals(READY, StreamingReadiness.evaluate(100 * MIB, MIB, 512 * 1024, 20_000));
        assertEquals(TOO_SLOW, StreamingReadiness.evaluate(100 * MIB, MIB, 512 * 1024 - 1, 20_000));
    }
}
