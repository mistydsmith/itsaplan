# Proof target for the anchor-map stamp tests (sentinel-prod-8428).
# A real .py file shipped INSIDE this repo (A4: repo-relative fixture, no
# author-local cross-lane paths): the tests copy it into a temp git checkout
# and the shared sentinel-prod tool maps it exactly as it maps a landed file.
import hashlib


def make_thing(scale):
    return Thing() * scale


def other():
    return make_thing(2) + hashlib.sha256(b"x").hexdigest()
