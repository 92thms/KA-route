import os
import socket
import httpx
from fastapi.testclient import TestClient
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from api.main import app


def _get_client():
    app.router.on_startup = []
    app.router.on_shutdown = []
    return TestClient(app)


def test_proxy_allows_host(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")

    async def fake_get(self, url, headers=None):
        return httpx.Response(200, content=b"ok", headers={"content-type": "text/plain"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://example.com/test"})
    assert resp.status_code == 200
    assert resp.text == "ok"


def test_proxy_blocks_disallowed_host(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")
    called = False

    async def fake_get(self, url, headers=None):
        nonlocal called
        called = True
        return httpx.Response(200, content=b"ok")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://blocked.example/test"})
    assert resp.status_code == 403
    assert not called


def test_proxy_blocks_private_ip(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    called = False

    async def fake_get(self, url, headers=None):
        nonlocal called
        called = True
        return httpx.Response(200, content=b"ok")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://example.com"})
    assert resp.status_code == 403
    assert not called
