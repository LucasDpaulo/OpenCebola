package br.cebola.app;

import java.io.File;
import java.io.IOException;
import java.util.UUID;

/** Diretório exclusivo de vídeo temporário; nunca toca login, preferências ou downloads de livros. */
public final class TemporaryVideoStorage {
    private final File root;

    public TemporaryVideoStorage(File appCacheDirectory) throws IOException {
        root = new File(appCacheDirectory.getCanonicalFile(), "cebola-streaming");
        if (!root.getCanonicalFile().equals(root.getAbsoluteFile())) {
            throw new IOException("Diretório de streaming inválido");
        }
    }

    /** Só chamar depois de fechar o motor, para não apagar arquivos ainda em uso. */
    public synchronized void clear() throws IOException {
        remove(root);
    }

    public synchronized File begin() throws IOException {
        clear(); // Recupera resíduos de crash antes de começar outra sessão.
        File session = new File(root, UUID.randomUUID().toString());
        if (!session.mkdirs()) throw new IOException("Não foi possível criar cache temporário");
        return session;
    }

    private static void remove(File file) throws IOException {
        // Não seguir symlinks: apagar somente o link, nunca seu destino.
        boolean link = !file.getCanonicalFile().equals(file.getAbsoluteFile());
        if (!link && file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Não foi possível ler cache temporário");
            for (File child : children) remove(child);
        }
        if ((file.exists() || link) && !file.delete()) {
            throw new IOException("Não foi possível limpar cache temporário");
        }
    }
}
