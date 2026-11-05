package br.cebola.app;

import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.content.ActivityNotFoundException;
import androidx.core.content.FileProvider;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/** O seletor do Android salva fora da WebView, sem permissão ampla de armazenamento. */
@CapacitorPlugin(name = "BookDownloads")
public class BookDownloadsPlugin extends Plugin {
    private final AtomicBoolean saving = new AtomicBoolean(false);
    private static final int MAX_BYTES = 25 * 1024 * 1024;

    @Override
    public void load() {
        File[] leftovers = getContext().getCacheDir().listFiles((dir, name) -> name.startsWith("cebola-book-") && name.endsWith(".epub"));
        if (leftovers != null) for (File file : leftovers) {
            if (System.currentTimeMillis() - file.lastModified() > 60L * 60L * 1000L) file.delete();
        }
    }

    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("base64", "");
        String filename = call.getString("filename", "livro.epub");
        if (data.isEmpty() || data.length() > ((MAX_BYTES + 2) / 3) * 4
            || !filename.matches("[a-zA-Z0-9_-]{1,100}\\.epub")) {
            call.reject("Arquivo EPUB inválido.");
            return;
        }
        if (!saving.compareAndSet(false, true)) {
            call.reject("Conclua o download anterior.");
            return;
        }
        // Capacitor serializa os argumentos no Bundle ao suspender a Activity. Base64 de
        // um livro de 13 MB excederia o limite de transação do Android. Só o nome temporário
        // atravessa o seletor; os bytes nunca vão para savedInstanceState.
        call.getData().remove("base64");
        new Thread(() -> {
            File temporary = null;
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                if (bytes.length < 4 || bytes.length > MAX_BYTES || bytes[0] != 'P' || bytes[1] != 'K') {
                    throw new IllegalArgumentException("EPUB inválido");
                }
                File[] cached = getContext().getCacheDir().listFiles((dir, name) -> name.startsWith("cebola-book-") && name.endsWith(".epub"));
                long used = 0;
                if (cached != null) for (File file : cached) used += file.length();
                if (used + bytes.length > 3L * MAX_BYTES) throw new java.io.IOException("Cache de livros cheio; aguarde a limpeza automática.");
                temporary = File.createTempFile("cebola-book-", ".epub", getContext().getCacheDir());
                try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); }
                call.getData().put("temporaryFile", temporary.getName());
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/epub+zip");
                intent.putExtra(Intent.EXTRA_TITLE, filename);
                File pending = temporary;
                getActivity().runOnUiThread(() -> {
                    try { startActivityForResult(call, intent, "savedLocation"); }
                    catch (Exception error) {
                        pending.delete();
                        saving.set(false);
                        call.reject("Não foi possível abrir o seletor de arquivos.", error);
                    }
                });
            } catch (Exception error) {
                if (temporary != null) temporary.delete();
                saving.set(false);
                call.reject("Não foi possível preparar o EPUB. Verifique o espaço disponível.", error);
            }
        }, "cebola-book-prepare").start();
    }

    @PluginMethod
    public void kindle(PluginCall call) {
        String data = call.getString("base64", "");
        String filename = call.getString("filename", "livro.epub");
        call.getData().remove("base64");
        if (data.isEmpty() || data.length() > ((MAX_BYTES + 2) / 3) * 4
            || !filename.matches("[a-zA-Z0-9_-]{1,100}\\.epub")) {
            call.reject("Arquivo EPUB inválido.");
            return;
        }
        if (!saving.compareAndSet(false, true)) { call.reject("Aguarde o envio anterior."); return; }
        new Thread(() -> {
            File temporary = null;
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                if (bytes.length < 4 || bytes.length > MAX_BYTES || bytes[0] != 'P' || bytes[1] != 'K') {
                    throw new IllegalArgumentException("EPUB inválido");
                }
                load(); // Limpa somente arquivos antigos; o Kindle pode ler o atual depois do retorno.
                File[] cached = getContext().getCacheDir().listFiles((dir, name) -> name.startsWith("cebola-book-") && name.endsWith(".epub"));
                long used = 0;
                if (cached != null) for (File file : cached) used += file.length();
                if (used + bytes.length > 3L * MAX_BYTES) throw new java.io.IOException("Cache de livros cheio; aguarde a limpeza automática.");
                temporary = File.createTempFile("cebola-book-", ".epub", getContext().getCacheDir());
                try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", temporary);
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType("application/epub+zip");
                intent.setPackage("com.amazon.kindle");
                intent.putExtra(Intent.EXTRA_STREAM, uri);
                intent.putExtra(Intent.EXTRA_TITLE, filename);
                intent.putExtra(Intent.EXTRA_SUBJECT, filename.replace(".epub", ""));
                intent.setClipData(ClipData.newRawUri(filename, uri));
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                File pending = temporary;
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(intent);
                        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> pending.delete(), 60L * 60L * 1000L);
                        JSObject response = new JSObject();
                        response.put("opened", true);
                        call.resolve(response);
                    } catch (ActivityNotFoundException error) {
                        pending.delete();
                        call.reject("Instale ou atualize o Kindle para receber EPUBs. Você também pode salvar o arquivo e usar Enviar para Kindle.");
                    } catch (Exception error) {
                        pending.delete();
                        call.reject("Não foi possível enviar o livro ao Kindle.", error);
                    } finally { saving.set(false); }
                });
            } catch (Exception error) {
                if (temporary != null) temporary.delete();
                saving.set(false);
                call.reject("Não foi possível preparar o livro para o Kindle.", error);
            }
        }, "cebola-book-kindle").start();
    }

    @ActivityCallback
    private void savedLocation(PluginCall call, ActivityResult result) {
        if (call == null) { saving.set(false); return; }
        String name = call.getString("temporaryFile", "");
        if (!name.matches("cebola-book-[a-zA-Z0-9_-]+\\.epub")) {
            saving.set(false);
            call.reject("Baixe o livro novamente para salvar.");
            return;
        }
        File temporary = new File(getContext().getCacheDir(), name);
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            temporary.delete();
            saving.set(false);
            JSObject response = new JSObject();
            response.put("saved", false);
            call.resolve(response);
            return;
        }
        Uri destination = result.getData().getData();
        new Thread(() -> {
            try {
                if (!temporary.isFile() || temporary.length() > MAX_BYTES) throw new java.io.IOException("Arquivo temporário indisponível");
                try (FileInputStream input = new FileInputStream(temporary);
                     OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new java.io.IOException("Destino indisponível");
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                }
                JSObject response = new JSObject();
                response.put("saved", true);
                call.resolve(response);
            } catch (Exception error) {
                call.reject("Não foi possível salvar o EPUB. Verifique o espaço disponível.", error);
            } finally {
                temporary.delete();
                saving.set(false);
            }
        }, "cebola-book-save").start();
    }
}
