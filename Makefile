PLUGIN_NAME = ip-scanner
DEST = /usr/share/cockpit/$(PLUGIN_NAME)

.PHONY: build install uninstall clean

build:
	npm run build

install:
	mkdir -p $(DEST)
	cp dist/index.html $(DEST)/
	cp manifest.json $(DEST)/
	cp -f po.*.js $(DEST)/ 2>/dev/null || true

uninstall:
	rm -rf $(DEST)

clean:
	rm -rf dist
