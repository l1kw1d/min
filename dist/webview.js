/* imports common modules */

var electron = require("electron");
var ipc = electron.ipcRenderer;
var webFrame;
;/* send bookmarks data.  */

function getBookmarksText(doc, win) {

	var docClone = doc.cloneNode(doc, true);

	var ignoredElements = docClone.body.querySelectorAll('link, style, script, noscript, .visually-hidden, .visuallyhidden, [role=presentation], [hidden], [style*="display:none"], .ad, .dialog, .modal');

	if (ignoredElements) {
		for (var i = 0; i < ignoredElements.length; i++) {
			ignoredElements[i].parentNode.removeChild(ignoredElements[i]);
		}
	}

	var ignoreIfMinor = docClone.body.querySelectorAll("aside, .sidebar, #sidebar");

	if (ignoreIfMinor) {
		for (var i = 0; i < ignoreIfMinor.length; i++) {
			if (ignoreIfMinor[i].textContent.length / docClone.body.textContent.length < 0.075) {
				ignoreIfMinor[i].parentNode.removeChild(ignoreIfMinor[i]);
			}
		}
	}

	var pageElements = docClone.body.querySelectorAll("*");
	var text = "";

	for (var i = 0; i < pageElements.length; i++) {
		pageElements[i].insertAdjacentHTML("beforeend", " ");
	};

	text = docClone.body.textContent;

	//special meta tags

	var mt = docClone.querySelector("meta[name=description]");

	if (mt) {
		text += " " + mt.content;
	}

	text = text.replace(/[\n\t]/g, ""); //remove useless newlines/tabs that increase filesize

	text = text.replace(/\s{2,}/g, " "); //collapse multiple spaces into one
	text = text.replace(/<.*?>/g, "");

	return text;
}

ipc.on("sendData", function () {

	/* also parse special metadata: price, rating, location, cooking time */

	var price, rating, location, cookTime;

	//pricing

	var priceEl = document.querySelector("[itemprop=price], .price, .offer-price, #priceblock_ourprice, .discounted-price");
	var currencyEl = document.querySelector("[itemprop=priceCurrency], [property=priceCurrency]");

	if (priceEl) {
		price = priceEl.textContent;
	}

	if (!/\d/g.test(price)) { //if the price doesn't contain a number, it probably isn't accurate
		price = undefined;
	}

	if (price && price.indexOf("$") == -1 && currencyEl && navigator.language == "en-US") { //try to add a currency if we don't have one. We should probably check for other currencies, too.
		price = (currencyEl.content || currencyEl.textContent).replace("USD", "$") + price;
	}

	//ratings

	var ratingEl = document.querySelector('.star-img, .rating, [itemprop="ratingValue"], [property="ratingValue"]');

	if (!ratingEl) { //if we didn't find an element, try again with things that might be a rating element, but are less likely
		ratingEl = document.querySelector('[class^="rating"], [class^="review"]');
	}


	if (ratingEl) {
		rating = ratingEl.title || ratingEl.alt || ratingEl.content || ratingEl.textContent;
		rating = rating.replace("rating", "").replace("stars", "").replace("star", "").trim();
		console.log("r: " + rating);
		if (rating && /\d+$/g.test(rating)) { //if the rating ends in a number, we assume it means "stars", and append the prefix
			rating = rating + " stars";
		}
	}

	//location

	var locationEl = document.querySelector('[itemprop="location"], [itemprop="address"]');

	if (!locationEl) {
		var locationEl = document.querySelector('.adr, .addr, .address');
	}

	if (locationEl) {
		location = locationEl.textContent.trim();
	}

	//remove US postcodes, since these usually aren't important and they take up space
	//TODO make this work for other countries
	if (location && /,?\d{5}$/g.test(location)) {
		location = location.replace(/,?\d{5}$/g, "");
	}

	//cooking time

	var cookingTimeEl = document.querySelector('[itemprop="totalTime"], [itemprop="cookTime"]');

	if (cookingTimeEl) {
		cookTime = cookingTimeEl.textContent;
		cookTime = cookTime.replace(/\sm$/g, " minutes").replace(/\sh$/g, " hours");
		cookTime = cookTime.replace("1 hours", "1 hour");
	}


	console.log("rating: " + rating);
	console.log("price: " + price);
	console.log("location: " + location);

	var text = getBookmarksText(document, window);

	//try to also extract text for same-origin iframes (such as the reader mode frame)

	var frames = document.querySelectorAll("iframe");

	for (var x = 0; x < frames.length; frames++) {
		try {
			text += ". " + getBookmarksText(frames[x].contentDocument, frames[x].contentWindow);
		} catch (e) {}
	}


	ipc.sendToHost("bookmarksData", {
		url: window.location.toString(),
		title: document.title || "",
		text: text,
		extraData: {
			metadata: {
				price: price,
				rating: rating,
				location: location,
				cookTime: cookTime,
			}
		}
	});
});
;var contextMenuDefaultPrevented = false;

window.addEventListener("contextmenu", function (e) {
	contextMenuDefaultPrevented = e.defaultPrevented;
})

/* gets page data used for the context menu */

ipc.on("getContextData", function (event, cxData) {

	//the page is overriding the contextmenu event
	if (contextMenuDefaultPrevented) {
		return;
	}

	var element = document.elementFromPoint(cxData.x, cxData.y);

	if (element) {
		var src = element.href || element.src;

		if (element.tagName == "IMG" || element.tagName == "PICTURE") {
			var image = element.src;
		}
	}

	ipc.sendToHost("contextData", {
		selection: window.getSelection().toString(),
		src: src,
		image: image,
	});
})
;function debug_phishing(msg) {
	//uncomment for debug mode
	console.log(msg);
}


/* phishing detector. Implements methods from http://www.ml.cmu.edu/research/dap-papers/dap-guang-xiang.pdf and others, as well as some custom methods */

var tldRegex = /\.(com|net|org|edu|gov|mil)$/g;

var doubleDomainRegex = /\.(com|net|org|edu|gov|mil|uk|ca|jp|fr|au|us|ru|ch|it|nl|de|es)((\..*(com|net|org|edu|gov|mil))|(\..+(uk|ca|jp|fr|au|us|ru|ch|it|nl|de|es)))/g;

function checkPhishingStatus() {

	//if there isn't a password input or form, skip the phishing analysis, since this probably isn't a phish
	if (!document.querySelector("input[type=password], form")) {
		return false;
	}

	var scanStart = performance.now();

	function isSensitive(form) { //checks if a form is asking for sensitive information

		if (form.querySelector("input[type=password]")) {

			debug_phishing("form with password input found");
			sensitiveFormFound = true;

			return true;
		}

		if (form.querySelectorAll("input[type=text], input[type=password]").length == 2) {
			debug_phishing("possibly sensitive form, checking but increasing minScore");

			minPhishingScore *= 1.5;
			sensitiveFormFound = true;
			return true;
		}

		//empty forms can be misleading

		if (!form.querySelector("input")) {
			debug_phishing("empty form found, checking but not counting as sensitive");
			minPhishingScore += 0.35;
			return true;
		}

		//if the form contains a sensitive word
		var tx = form.textContent.toLowerCase();

		for (var i = 0; i < sensitiveFormWords.length; i++) {
			if (tx.indexOf(sensitiveFormWords[i]) != -1) {
				debug_phishing("sensitive word found in form, checking");
				sensitiveFormFound = true;
				minPhishingScore += 0.075;
				return true;
			}
		}

		return false;
	}

	function getRootDomain(hostname) {
		var newData = hostname;
		tldRegex.lastIndex = 0;
		var chunks = hostname.split(".");

		if (tldRegex.test(hostname)) {
			newData = chunks[chunks.length - 2] + "." + chunks[chunks.length - 1]
		}

		if (newData.indexOf("www.") == 0) {
			newData = newData.replace("www.", "");
		}
		return newData;
	}


	//if we have a password input, set a lower threshold

	if (document.querySelector("input[type=password]")) {
		minPhishingScore = 0.65;
	}

	var sensitiveWords = ["secure", "account", "webscr", "login", "ebayisapi", "signing", "banking", "confirm"];
	var sensitiveFormWords = ["password", "creditcard", "credit card", "security code", "expiration date", "card type", "social security", "income tax", "date of birth", "joint return"]; //word commonly found in forms that ask for personal information
	var whitelistedDomains = ["adobeid-na1.services.adobe.com", "www.zdnet.com"]; //a whitelist of things we mistakenly think are bad. These should be fixed eventually, but for now a whitelist will work.

	//on the whitelist

	for (var i = 0; i < whitelistedDomains.length; i++) {
		if (whitelistedDomains[i] === window.location.hostname) {
			console.log("domain is whitelisted, not checking");
			return;
		}
	}

	var loc = window.location.toString();
	var bodyText = document.body.textContent;
	var bodyHtml = document.body.innerHTML;

	var minPhishingScore = 1.25;
	var phishingScore = 0;

	//used for url parsing

	var aTest = document.createElement("a");

	//checks if the url has multiple domain endings in it. Catches things like "example.com.com", "example.com/example2.com", "secure.example.com.phishingsite.com", etc.

	if (doubleDomainRegex.test(loc)) {
		debug_phishing("found misleading domain");
		phishingScore += 0.0075 * window.location.toString().length;
	}

	//no https - either insecure, phishing, or both

	if (window.location.protocol != "https:" && window.location.protocol != "file:") {
		debug_phishing("no https");
		phishingScore += 0.15;
		if (window.location.protocol == "data:") {
			debug_phishing("data: protocol found");
			phishingScore += 0.25;
		}
	}

	//penalize long hostnames, since these are often used for phishing

	if (window.location.host.length > 25) {
		debug_phishing("long hostname detected");
		phishingScore += window.location.host.length * 0.0075;
	}

	//penalize extremely long locations, since these could also be used for phishing

	if (loc.split("?")[0].length > 75) {
		debug_phishing("long window location detected");
		phishingScore += Math.min(window.location.toString().length * 0.0001, 0.2);
	}

	if (loc.split("#")[0].split("/").length > 5) {
		debug_phishing("long path found");
		phishingScore += Math.max(loc.split("/").length * 0.05, 0.25);
	}

	//CANTINA - penalize locations with lots of dots

	if (window.location.hostname.split(".").length > 3 && window.location.hostname.length > 20) {
		debug_phishing("high number of . characters detected");
		phishingScore += Math.min(loc.split("?")[0].split(".").length * 0.03, 0.2);
	}

	//compromised websites used for phishing tend to host phishing pages within a directory to avoid detection. Real websites tend to have a url like example.com/login, though.

	if (window.location.pathname.length > 25) {
		debug_phishing("paths detected");
		phishingScore += Math.min(0.05 + (0.002 * window.location.pathname.length), 0.3);
	}


	if (isTrustedDomainEnding && window.location.pathname.length < 20 && window.location.hostname.replace("www.", "").length < 18) {
		debug_phishing("short root domain found, increasing minScore");
		minPhishingScore += 0.3 + 0.05 * (18 - window.location.hostname.length) - (0.01 * window.location.pathname.length);
	}

	var trustedTLDs = ["com", "org", "edu", "mil", "gov", "io"];

	var pageTLD = window.location.hostname.split(".").reverse()[0];

	var isTrustedDomainEnding = trustedTLDs.indexOf(pageTLD) != -1

	if (window.location.hostname && !isTrustedDomainEnding) {
		phishingScore += 0.15;
		debug_phishing("unusual domain ending found, increasing score");
	}

	sensitiveWords.forEach(function (word) {
		if (loc.toLowerCase().indexOf(word) != -1) {
			debug_phishing("detected sensitive word found in location");
			phishingScore += 0.025;
		}
	});

	//implements feature 8 from http://www.ml.cmu.edu/research/dap-papers/dap-guang-xiang.pdf

	var forms = document.querySelectorAll("form");
	var totalFormLength = 0;
	var formWithoutActionFound = false;
	var formWithSimplePathFound = false;
	var sensitiveFormFound = false;

	//loop through each form
	if (forms) {
		for (var i = 0; i < forms.length; i++) {
			var form = forms[i];
			var formText = form.innerHTML.toLowerCase();

			//if the form isn't sensitive, don't scan it

			if (!isSensitive(form)) {
				continue;
			}

			var fa = form.getAttribute("action");

			//if no action, form might be fake

			if (!fa || loc.split("?")[0].indexOf(fa.split("?")[0]) != -1) { //we also check if the form just submits to the same page with a different query string
				debug_phishing("form without action detected");
				formWithoutActionFound = true;
				continue;
			}

			totalFormLength += form.innerHTML.length;

			if ((form.getAttribute("onsubmit") && form.getAttribute("onsubmit") != "return false") || form.getAttribute("onkeydown") || form.getAttribute("onkeypress") || form.getAttribute("onkeyup")) {
				debug_phishing("js html inline attributes detected");
				phishingScore += 0.05;
			}

			//if the form action is in the same directory as the current page, it is likely to be phishing

			var slashCt = fa.replace(window.location.toString(), "").replace(window.location.pathname, "").split("/").length - 1;

			if (fa.indexOf("javascript:") != 0 && slashCt < 2) {
				debug_phishing("form with simple path for action detected");
				formWithSimplePathFound = true;
			} else if (slashCt < 3) {
				debug_phishing("non-absolute form path detected");
				phishingScore += 0.1;
			}

			//many toolkits seem to use php files, but most legitimate websites don't

			if (fa.indexOf(".php") != -1) {
				debug_phishing("php file action found");
				phishingScore += 0.075;
			}

			aTest.href = fa;

			// if the form is submitted to a different domain, it is suspicious

			if (fa.indexOf("javascript:") != 0 && getRootDomain(aTest.hostname) != getRootDomain(window.location.hostname)) {
				debug_phishing("submitting form to xdomain");
				phishingScore += 0.7;
			}


			if (aTest.protocol != "https:") {
				debug_phishing("submitting form without https");
				phishingScore += 0.15;
			}

		}

		if (formWithoutActionFound == true) {
			phishingScore += 0.4;
			phishingScore += Math.min(0.2, totalFormLength * 0.0001)
		}

		if (formWithSimplePathFound == true) {
			phishingScore += 0.75;
		}
	}
	if (!sensitiveFormFound && !document.querySelector("input[type=password]")) {
		debug_phishing("no sensitive forms found, increasing minScore");

		minPhishingScore += 0.33;
	}

	var links = document.querySelectorAll("a, area[href]"); //area tag is for image maps

	var linkDomains = {};
	var linkSources = {};

	var emptyLinksFound = 0;
	var javascriptLinksFound = 0;

	for (var i = 0; i < links.length; i++) {

		var href = links[i].getAttribute("href");

		//if href is blank or meaningless, page is more likely to be phishing (http://www.ml.cmu.edu/research/dap-papers/dap-guang-xiang.pdf item 9)

		if (!href || href == "#" && !links[i].onclick) { //ignore links that have a javascript handler, since these are expected to have an empty href
			emptyLinksFound++;
			continue;
		}

		//phishing sites use javascript: url's more often than legitimate sites, check for that

		if (href.indexOf("javascript:") == 0) {
			javascriptLinksFound++;
		}

		aTest.href = links[i].href;

		linkDomains[aTest.host] = linkDomains[aTest.host] + 1 || 1;
		linkSources[href] = linkSources[href] + 1 || 1;
	}

	//if there are several external links that point to the same domain, increase likelyhood of phishing

	var sameDomainLinks = 0;
	var totalLinks = 0;

	var rd = getRootDomain(window.location.host);

	for (var key in linkDomains) {
		totalLinks += linkDomains[key];
		if (getRootDomain(key) == rd) {
			sameDomainLinks += linkDomains[key];
			continue;
		}
		if (linkDomains[key] > 4 && key && linkDomains[key] / totalLinks > 0.25) {
			debug_phishing("found " + linkDomains[key] + " links that point to domain " + key)
			phishingScore += Math.min(0.1 * linkDomains[key], 0.25);
			break; //we don't want to increase the phishing score more than once
		}
	}

	//if all or most of the links on the page are to external domains, likely to be phishing

	if (totalLinks > 2 && sameDomainLinks == 0 || (totalLinks > 5 && sameDomainLinks / totalLinks < 0.15)) {
		debug_phishing("links go to external domain");
		phishingScore += Math.min(0.1 + (totalLinks - sameDomainLinks) * 0.1, 0.5);
	}

	//if there are a bunch of empty links, increase score
	if (emptyLinksFound > 9 || (totalLinks > 2 && emptyLinksFound / totalLinks > 0.5)) {
		debug_phishing("counted " + emptyLinksFound + " empty links");
		phishingScore += Math.min(emptyLinksFound * 0.02, 0.2);
	}

	//if there are a lot of js links
	if (javascriptLinksFound > 3) {
		debug_phishing("counted " + javascriptLinksFound + " javascript links");
		phishingScore += 0.1;
	}

	//if most of the page isn't forms, set a higher threshold

	var totalDocLength = bodyHtml.length;

	if (totalFormLength > 50 && totalFormLength < 1000 && totalFormLength / totalDocLength < 0.075) {
		debug_phishing("forms are very minor part of page, increasing minScore");
		minPhishingScore += Math.min(1.15 - totalFormLength / totalDocLength, 1.2);
	} else if (totalFormLength > 50 && totalFormLength < 3500 && totalFormLength / totalDocLength < 0.14) {
		debug_phishing("forms are minor part of page, increasing minScore (small)");
		debug_phishing(totalFormLength);
		debug_phishing(totalDocLength);
		minPhishingScore += 0.25;
	}

	//checks if most, but not all of the scripts on a page come from an external domain, possibly indicating an injected phishing script
	var scripts = document.querySelectorAll("script");

	var scriptSources = {};
	var totalScripts = 0;
	if (scripts) {
		for (var i = 0; i < scripts.length; i++) {
			if (scripts[i].src) {
				aTest.href = scripts[i].src;
				var scriptHost = aTest.hostname;
				scriptSources[scriptHost] = scriptSources[scriptHost] + 1 || 1;
				totalScripts++;
			}
		}
	}

	var previous = 0;

	for (var source in scriptSources) {
		if (scriptSources[source] > 2 && scriptSources[source] / totalScripts > 0.75 && scriptSources[source] < 0.95) {
			phishingScore += 0.1;
			debug_phishing("external scripts found, increasing score");
		}
		previous = scriptSources[source];
	}

	//if we have lots of forms, we need a higher threshold, since phishingScore tends to increase with more forms

	if (forms.length > 3) {
		debug_phishing("many forms found, increasing minScore");
		minPhishingScore += Math.min(0.05 * forms.length, 0.2);
	}

	//tries to detect pages that use images to copy a ui

	if (document.body.innerHTML.length < 4500) {
		debug_phishing("small amount of body text, multiplying score");
		phishingScore *= 1.4;
	}

	var icon = document.querySelector('link[rel="shortcut icon"]');

	if (icon && icon.href) {
		aTest.href = icon.href;

		if (getRootDomain(aTest.hostname) != rd) {
			debug_phishing("icon from external domain found");
			phishingScore += 0.1;
		}
	}

	var paragraphs = document.querySelectorAll("p");
	if (paragraphs.length > 50) {
		debug_phishing("many paragraphs found, increasing minScore");
		minPhishingScore += 0.1 + Math.min(0.025 * paragraphs.length, 0.2);
	}

	// finally, if the phishing score is above a threshold, alert the parent process so we can redirect to a warning page

	console.log("min " + minPhishingScore);

	console.log("status", phishingScore);

	if (phishingScore > minPhishingScore) {
		ipc.sendToHost("phishingDetected");
	}

	var scanEnd = performance.now();

	console.log("phishing scan took " + (scanEnd - scanStart) + " milliseconds");

	return true;
}

var didCheckStatus = false;

window.addEventListener("load", function () {
	didCheckStatus = true;
	setTimeout(checkPhishingStatus, 1000);
});

document.addEventListener("DOMContentLoaded", checkPhishingStatus)

//if the load event never fires, we still want to check

setTimeout(function () {
	if (!didCheckStatus) {
		checkPhishingStatus();
	}
}, 2500);
;/* detects if a page is readerable, and tells the main process if it is */

function getReaderScore() {
	var paragraphs = document.querySelectorAll("p");
	var tl = 0;
	if (!paragraphs) {
		return;
	}
	for (var i = 0; i < paragraphs.length; i++) {
		tl += Math.max(paragraphs[i].textContent.length - 100, -30);
	}
	return tl;
}

window.addEventListener("load", function (e) {
	var tl = getReaderScore();

	//for debugging
	//window._browser_readerScore = tl;

	if (tl > 650 || (document.querySelector("article") && tl > 200)) {
		//the page is probably an article

		//some websites can cause multiple did-finish-load events. In webview.js, we assume these mean a new page, and set readerable to false. Because of this, if we send canReader, and later there is another load event, the button will never show up. To get around this, we send multiple canReader events at intervals.

		setTimeout(function () {
			ipc.sendToHost("canReader");
		}, 500);

		setTimeout(function () {
			ipc.sendToHost("canReader");
		}, 2500);

	}
})
;/* detects back/forward swipes */

var totalMouseMove = 0;
var verticalMouseMove = 0;
var eventsCaptured = 0;
var documentUnloaded = false

window.addEventListener("mousewheel", function (e) {

	verticalMouseMove += e.deltaY;
	eventsCaptured++;

	/* cmd-key while scrolling should zoom in and out */

	if (verticalMouseMove > 55 && e.metaKey && eventsCaptured > 1) {
		verticalMouseMove = -10;
		return zoomOut();
	}

	if (verticalMouseMove < -55 && e.metaKey && eventsCaptured > 1) {
		verticalMouseMove = -10;
		return zoomIn();
	}
	if (e.deltaY > 5 || e.deltaY < -10) {
		return;
	}

	if (!documentUnloaded) {

		totalMouseMove += e.deltaX


		if (totalMouseMove < -150) {
			doneNavigating = true;
			window.history.back();
			documentUnloaded = true;
			setTimeout(function () {
				documentUnloaded = false;
			}, 3000);
		} else if (totalMouseMove > 100) {
			documentUnloaded = true;
			window.history.go(1);
			setTimeout(function () {
				documentUnloaded = false;
			}, 3000);
		}

	}
});

setInterval(function () {
	totalMouseMove = 0;
}, 4000);

setInterval(function () {
	verticalMouseMove = 0;
	eventsCaptured = 0;
}, 1000);
;/* zooms the page in an out, and resets */

var _browser_zoomLevel = 0;
var _browser_maxZoom = 9;
var _browser_minZoom = -8;

function zoomIn() {
	if (!webFrame) {
		webFrame = electron.webFrame;
	}

	if (_browser_maxZoom > _browser_zoomLevel) {
		_browser_zoomLevel += 1;
	}
	webFrame.setZoomLevel(_browser_zoomLevel);
}

function zoomOut() {
	if (!webFrame) {
		webFrame = electron.webFrame;
	}

	if (_browser_minZoom < _browser_zoomLevel) {
		_browser_zoomLevel -= 1;
	}
	webFrame.setZoomLevel(_browser_zoomLevel);
}

function zoomReset() {
	if (!webFrame) {
		webFrame = electron.webFrame;
	}

	_browser_zoomLevel = 0;
	webFrame.setZoomLevel(_browser_zoomLevel);
}

ipc.on("zoomIn", zoomIn);
ipc.on("zoomOut", zoomOut);
ipc.on("zoomReset", zoomReset);
;function isScrolledIntoView(el) { //http://stackoverflow.com/a/22480938/4603285
	var elemTop = el.getBoundingClientRect().top;
	var elemBottom = el.getBoundingClientRect().bottom;

	var isVisible = elemTop < window.innerHeight && elemBottom >= 0
	return isVisible;
}

ipc.on("getKeywordsData", function (e) {

	function extractPageText(doc) {
		var ignore = ["LINK", "STYLE", "SCRIPT", "NOSCRIPT", "svg", "symbol", "title", "path", "style"];
		var text = "";
		var pageElements = doc.querySelectorAll("p, h2, h3, h4, li, [name=author], [itemprop=name], .article-author");

		var scrollY = window.scrollY;
		for (var i = 0; i < pageElements.length; i++) {

			var el = pageElements[i];

			if ((!isScrolledIntoView(pageElements[i]) && doc == document) || (pageElements[i].tagName == "META" && scrollY > 500) || pageElements[i].textContent.length < 50 || pageElements[i].querySelector("time, span, div, menu")) {
				continue;
			}

			if (ignore.indexOf(el.tagName) == -1) {

				var elText = el.textContent || el.content

				if (pageElements[i - 1] && /\.\s*$/g.test(pageElements[i - 1].textContent)) {
					text += " " + elText
				} else {
					text += ". " + elText
				}

			}
		}

		text = text.replace(/[\n\t]/g, ""); //remove useless newlines/tabs that increase filesize

		return text;
	}

	if (getReaderScore() < 400 && window.location.toString().indexOf("reader/index.html") == -1) {
		return;
	}

	var text = extractPageText(document);

	var frames = document.querySelectorAll("iframe");

	if (frames) {
		for (var i = 0; i < frames.length; i++) {
			try { //reading contentDocument will throw an error if the frame is not same-origin
				text += " " + extractPageText(frames[i].contentDocument);
			} catch (e) {

			}
		}
	}

	var nlp = require("nlp_compromise");

	var items = nlp.spot(text, {});

	var entities = [];

	items.forEach(function (item) {
		if (item.pos_reason.indexOf("noun_capitalised") == -1) {
			return;
		}

		entities.push(item.text.replace(/[^a-zA-Z\s]/g, ""));
	});

	ipc.sendToHost("keywordsData", {
		entities: entities,
	});

});
