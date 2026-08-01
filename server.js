package org.untitled.untitled3.client;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.multiplayer.MultiplayerScreen;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import java.io.*;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class LicenseManager {
    private static boolean isVerified, isKeyAccepted;
    private static final String LICENSE_FILE = "mods/.ravge_license";
    private static final String API_URL = "https://ravge-panel.vercel.app/api/verify";

    private static boolean isHeartbeatStarted = false;
    
    // ДОБАВЛЯЕМ: Флаг для отслеживания, был ли игрок на сервере
    private static boolean wasOnServer = false;
    // ДОБАВЛЯЕМ: Флаг для предотвращения повторной отправки при shutdown
    private static boolean shutdownHookInstalled = false;

    public static boolean isVerified() { return isVerified; }
    public static boolean isKeyAccepted() { return isKeyAccepted; }

    public static boolean onChatMessage(String message) {
        if (message == null || message.trim().isEmpty()) return false;
        String trimmed = message.trim();

        if (trimmed.startsWith(".code ")) {
            String key = trimmed.substring(6).trim();
            activateViaChat(key);
            return true;
        }

        if (trimmed.startsWith(".reg ")) {
            String[] args = trimmed.substring(5).trim().split("\\s+");
            if (args.length < 2) {
                sendClientMessage("Использование: .reg [логин] [пароль]", Formatting.RED);
            } else {
                registerCredentialsViaChat(args[0], args[1]);
            }
            return true;
        }

        return false;
    }

    public static void deleteLicense() {
        isVerified = false;
        isKeyAccepted = false;
        try {
            File f = new File(MinecraftClient.getInstance().runDirectory, LICENSE_FILE);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {}
        sendClientMessage("Ключ удален", Formatting.RED);
    }

    public static void lockLicense() {
        isVerified = false;
        isKeyAccepted = false;
        try {
            File f = new File(MinecraftClient.getInstance().runDirectory, LICENSE_FILE);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {}
        sendClientMessage("Ключ заблокирован", Formatting.DARK_RED);
    }

    // ДОБАВЛЯЕМ: Метод для вызова при входе на сервер
    public static void onServerJoin(String serverAddress) {
        wasOnServer = true;
        new Thread(() -> {
            String key = getSavedKey();
            if (key != null && isKeyAccepted) {
                sendServerRequest(key, "check", "", "");
            }
        }).start();
    }

    // ДОБАВЛЯЕМ: Метод для вызова при выходе в меню
    public static void onDisconnectToMenu() {
        if (!wasOnServer) return;
        wasOnServer = false;
        
        new Thread(() -> {
            String key = getSavedKey();
            if (key != null && isKeyAccepted) {
                // Отправляем статус "В меню" напрямую через sync метод
                sendServerRequestSync(key, "check", "В меню");
            }
        }).start();
    }

    private static String getSavedKey() {
        try {
            File f = new File(MinecraftClient.getInstance().runDirectory, LICENSE_FILE);
            if (!f.exists()) return null;
            try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                String k = r.readLine();
                return (k == null || k.trim().isEmpty()) ? null : k.trim();
            }
        } catch (Exception e) { return null; }
    }

    private static void startHeartbeatLoop() {
        if (isHeartbeatStarted) return;
        isHeartbeatStarted = true;

        Thread heartbeatThread = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(15000);
                    String key = getSavedKey();
                    if (key != null && isKeyAccepted) {
                        sendServerRequest(key, "check", "", "");
                    }
                } catch (InterruptedException e) {
                    break;
                } catch (Exception ignored) {}
            }
        });
        heartbeatThread.setDaemon(true);
        heartbeatThread.start();
    }

    public static void checkLicenseAsync(boolean silent) {
        new Thread(() -> {
            String key = getSavedKey();
            if (key == null) {
                if (!silent) sendClientMessage("Лицензия не найдена! Введите .code [ключ]", Formatting.RED);
                return;
            }
            String res = sendServerRequest(key, "check", "", "");
            isKeyAccepted = "success".equals(res) || "need_registration".equals(res);
            isVerified = "success".equals(res);
            if (!silent && isVerified) sendClientMessage("Авторизация пройдена!", Formatting.GREEN);
            if (!silent && "need_registration".equals(res)) sendClientMessage("Введите: .reg [логин] [пароль]", Formatting.YELLOW);
            if (!silent && !isVerified && !"need_registration".equals(res)) sendClientMessage("ОШИБКА: " + res, Formatting.RED);

            if (isKeyAccepted) {
                startHeartbeatLoop();
                setupShutdownHook();
            }
        }).start();
    }

    public static void activateViaChat(String enteredKey) {
        final String finalKey = enteredKey.trim().toUpperCase();
        new Thread(() -> {
            sendClientMessage("Проверка ключа...", Formatting.YELLOW);
            String res = sendServerRequest(finalKey, "check", "", "");
            if ("success".equals(res) || "need_registration".equals(res)) {
                try {
                    File f = new File(MinecraftClient.getInstance().runDirectory, LICENSE_FILE);
                    if (f.getParentFile() != null) f.getParentFile().mkdirs();
                    try (BufferedWriter w = new BufferedWriter(new FileWriter(f))) { w.write(finalKey); }
                } catch (Exception ignored) {}
                isKeyAccepted = true;
                isVerified = "success".equals(res);
                sendClientMessage(isVerified ? "Ключ верен! Активировано!" : "Ключ верен! Зарегистрируйтесь: .reg [логин] [пароль]", isVerified ? Formatting.GREEN : Formatting.GOLD);

                startHeartbeatLoop();
                setupShutdownHook();
            } else {
                isVerified = isKeyAccepted = false;
                sendClientMessage("ОШИБКА: " + res, Formatting.RED);
            }
        }).start();
    }

    public static void registerCredentialsViaChat(String login, String password) {
        new Thread(() -> {
            String key = getSavedKey();
            if (key == null) { sendClientMessage("Сначала введите .code [ключ]", Formatting.RED); return; }
            sendClientMessage("Регистрация аккаунта...", Formatting.YELLOW);
            String res = sendServerRequest(key, "register", login.trim(), password.trim());

            if ("success".equals(res) || "need_registration".equals(res)) {
                isVerified = true;
                isKeyAccepted = true;
                sendClientMessage("УСПЕШНО!", Formatting.GREEN);

                startHeartbeatLoop();
                setupShutdownHook();
            } else {
                sendClientMessage("ОШИБКА РЕГИСТРАЦИИ: " + res, Formatting.RED);
            }
        }).start();
    }

    // ИЗМЕНЯЕМ: setupShutdownHook теперь отправляет "Офлайн"
    private static void setupShutdownHook() {
        if (shutdownHookInstalled) return;
        shutdownHookInstalled = true;
        
        try {
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                String key = getSavedKey();
                if (key != null && isKeyAccepted) {
                    // Отправляем "Офлайн" при закрытии игры
                    sendServerRequestSync(key, "check", "Офлайн");
                }
            }));
        } catch (IllegalArgumentException ignored) {}
    }

    // ИЗМЕНЯЕМ: Теперь принимает статус как параметр
    private static void sendServerRequestSync(String targetKey, String action, String forcedServerStatus) {
        try {
            MinecraftClient mc = MinecraftClient.getInstance();
            String pName = (mc.getSession() != null) ? mc.getSession().getUsername() : "Unknown";
            String rawHwid = System.getenv("COMPUTERNAME") + System.getenv("PROCESSOR_IDENTIFIER") + System.getProperty("os.arch");
            String gHwid = java.util.UUID.nameUUIDFromBytes(rawHwid.getBytes(StandardCharsets.UTF_8)).toString().toUpperCase();

            String query = "?key=" + URLEncoder.encode(targetKey.trim().toUpperCase(), StandardCharsets.UTF_8) 
                    + "&hwid=" + gHwid
                    + "&name=" + URLEncoder.encode(pName, StandardCharsets.UTF_8) 
                    + "&server=" + URLEncoder.encode(forcedServerStatus, StandardCharsets.UTF_8) 
                    + "&action=" + action
                    + "&login=&password=";

            ProcessBuilder pb = new ProcessBuilder("curl", "-s", "-X", "GET", "--max-time", "5", API_URL + query);
            Process process = pb.start();
            process.waitFor();
        } catch (Exception ignored) {}
    }

    private static String sendServerRequest(String targetKey, String action, String login, String password) {
        try {
            MinecraftClient mc = MinecraftClient.getInstance();
            String pName = (mc.getSession() != null) ? mc.getSession().getUsername() : "Unknown";

            String sIp = "В главном меню";
            if (mc.world != null) {
                if (mc.getCurrentServerEntry() != null) {
                    sIp = mc.getCurrentServerEntry().address;
                } else if (mc.isInSingleplayer()) {
                    sIp = "В одиночной игре";
                }
            } else if (mc.currentScreen instanceof TitleScreen || mc.currentScreen instanceof MultiplayerScreen) {
                sIp = "В главном меню";
            } else if (mc.currentScreen != null) {
                sIp = "В меню (" + mc.currentScreen.getClass().getSimpleName() + ")";
            }

            String rawHwid = System.getenv("COMPUTERNAME") + System.getenv("PROCESSOR_IDENTIFIER") + System.getProperty("os.arch");
            String gHwid = java.util.UUID.nameUUIDFromBytes(rawHwid.getBytes(StandardCharsets.UTF_8)).toString().toUpperCase();

            String query = "?key=" + URLEncoder.encode(targetKey.trim().toUpperCase(), StandardCharsets.UTF_8) 
                    + "&hwid=" + gHwid
                    + "&name=" + URLEncoder.encode(pName, StandardCharsets.UTF_8) 
                    + "&server=" + URLEncoder.encode(sIp, StandardCharsets.UTF_8) 
                    + "&action=" + action
                    + "&login=" + URLEncoder.encode(login, StandardCharsets.UTF_8) 
                    + "&password=" + URLEncoder.encode(password, StandardCharsets.UTF_8);

            String fullUrl = API_URL + query;

            ProcessBuilder pb = new ProcessBuilder(
                    "curl", "-s", "-X", "GET",
                    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
                    "-H", "Accept: application/json",
                    "--max-time", "20",
                    fullUrl
            );

            Process process = pb.start();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader in = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    sb.append(line);
                }
            }

            String res = sb.toString();
            if (res.isEmpty()) return "Панель не отвечает. Проверьте сеть.";

            if (res.contains("\"success\":true")) {
                if (res.contains("\"need_register\":true")) {
                    return "need_registration";
                }
                return "success";
            }
            if (res.contains("\"error\":\"")) {
                int start = res.indexOf("\"error\":\"") + 9;
                return res.substring(start, res.indexOf("\"", start));
            }

            if (res.contains("need_registration") || res.contains("need_register")) {
                return "need_registration";
            }
            if (res.contains("success")) {
                return "success";
            }
        } catch (Exception e) {
            return "Ошибка отправки запроса: " + e.getMessage();
        }
        return "Unknown state";
    }

    private static void sendClientMessage(String msg, Formatting color) {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.player != null) {
            mc.player.sendMessage(Text.literal(msg).formatted(color), false);
        }
    }
}
