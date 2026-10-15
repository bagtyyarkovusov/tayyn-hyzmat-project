# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ROOT CAUSE of a real, repeatable release-build crash (confirmed via a real
# device logcat + R8's own mapping.txt, 2026-08-27): Capacitor's bundled
# proguard-rules.pro (node_modules/@capacitor/android/capacitor/proguard-
# rules.pro) has `-keep @com.getcapacitor.annotation.CapacitorPlugin public
# class * {...}` and `-keep public class * extends com.getcapacitor.Plugin
# {*;}` - these keep every plugin's CLASS SHAPE (class itself, its methods,
# their names) from being removed/renamed, which is why e.g.
# GeolocationPlugin.requestPermissions kept its exact name in the crash
# trace. What neither of those rules do is protect the ANNOTATION METADATA
# ITSELF (the RuntimeVisibleAnnotations class-file attribute) - R8 strips
# that by default unless something explicitly says to keep it, and nothing
# in this project did. So `pluginClass.getAnnotation(CapacitorPlugin.class)`
# - real reflection Capacitor's own Plugin.requestPermissions() runs on
# every plugin call - returned null in the shipped release APK even though
# every plugin class visibly has @CapacitorPlugin(...) in source, sending
# every permission request down Capacitor's legacy pre-3.0 @NativePlugin
# fallback path, which then dereferences ITS OWN (also-stripped, so also
# null) annotation and throws - this is what actually crashed, not
# anything specific to the geolocation plugin. Confirmed via R8's mapping.txt:
# obfuscated line 10 of com.getcapacitor.z(=Plugin).requestPermissions -
# the exact line in the crash - mapped straight to handleLegacyPermission().
# Debug builds never minify by default, which is why this only ever showed
# up in release APKs.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault

# BELT AND SUSPENDERS (2026-08-27, same day): a real device retest with the
# rule above still crashed with the byte-for-byte identical trace. Keeping
# the *attribute* isn't provably enough on its own here - the annotation
# TYPES themselves (CapacitorPlugin, Permission, PermissionCallback,
# ActivityCallback, NativePlugin under com.getcapacitor.annotation.*, plus
# the legacy com.getcapacitor.NativePlugin) are still fair game for R8 to
# rename/restructure unless separately kept, and any inconsistency between
# how the stored annotation data references its type and how reflection
# calls like `pluginClass.getAnnotation(CapacitorPlugin.class)` resolve that
# same type is exactly the kind of thing that reproduces as `null` instead
# of a build error. Rather than keep chasing the minimal exact rule,
# stop R8 from touching Capacitor's own framework/bridge code at all - it's
# a small fraction of total app size, and every plugin's actual permission
# handling flows through it on every call.
-keep class com.getcapacitor.** { *; }
-keep interface com.getcapacitor.** { *; }
-keepattributes Signature,InnerClasses,EnclosingMethod,RuntimeInvisibleAnnotations
