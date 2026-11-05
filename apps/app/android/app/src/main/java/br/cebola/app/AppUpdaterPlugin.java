package br.cebola.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Independent builds are updated by their owner, using their own signing keys. */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    @PluginMethod
    public void check(PluginCall call) {
        JSObject result = new JSObject();
        result.put("checked", false);
        result.put("available", false);
        call.resolve(result);
    }
    @PluginMethod
    public void install(PluginCall call) {
        call.reject("Atualize pelo código-fonte da sua instalação OpenCebola.");
    }
}
