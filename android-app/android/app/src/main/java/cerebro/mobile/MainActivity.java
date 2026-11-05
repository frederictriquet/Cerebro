package cerebro.mobile;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Capacitor leaves the back button to Android, which would close the app from any screen: walk back through
        // the mobile view's history first, then send the app to the background from its first page.
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    WebView webView = getBridge().getWebView();
                    if (webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        moveTaskToBack(true);
                    }
                }
            }
        );
    }

    @Override
    public void onPause() {
        super.onPause();
        // The WebView writes cookies to disk lazily: without this, the token cookie set just before Android kills
        // the app would be lost, and the token screen would come back.
        CookieManager.getInstance().flush();
    }
}
