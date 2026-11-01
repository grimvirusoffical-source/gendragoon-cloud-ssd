"""Validated cross-platform browser launcher for Red-XAI Quick Login."""
import os
import shutil
import subprocess
import sys
import urllib.parse
import webbrowser

class BrowserLaunchError(RuntimeError):pass

def validate(url):
    value=urllib.parse.urlsplit(url)
    if (value.scheme!="https" or value.netloc!="red-xai.com"
            or value.path not in ("/redxai-connect","/redxai-connect/","/redxai-connectx")
            or value.query or not value.fragment.startswith("request=")):
        raise BrowserLaunchError("The Red-XAI approval URL failed validation.")
    return url

def open_approval(url):
    url=validate(url)
    try:
        if webbrowser.open(url,new=2,autoraise=True):return True
    except Exception:
        pass
    try:
        if sys.platform=="win32":
            os.startfile(url)
            return True
        if sys.platform=="darwin":
            command=["/usr/bin/open",url]
        elif sys.platform.startswith("linux"):
            executable=shutil.which("xdg-open")
            if not executable:raise FileNotFoundError
            command=[executable,url]
        else:raise FileNotFoundError
        subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
        return True
    except Exception:
        raise BrowserLaunchError("Could not open the Red-XAI approval page in a browser.") from None
