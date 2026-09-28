/* Leaflet.Marker.SlideTo — vendored as-is from src/CommonTemplates/leaflet_marker_slideto
   (used by the native 1C map's track playback, Карта_Map_js: playTrack).
   Adds slideTo()/slideCancel() to L.Marker and L.CircleMarker for smooth
   marker animation between two LatLngs. No 1C-specific code inside. */

// class Marker

L.Marker.include({

	_slideToUntil:    undefined,
	_slideToDuration: undefined,
	_slideToLatLng:   undefined,
	_slideFromLatLng: undefined,
	_slideKeepAtCenter: undefined,
	_slideDraggingWasAllowed: undefined,

	// method slideTo(latlng: LatLng, options: Slide Options): this
	// Moves this marker until `latlng`, like `setLatLng()`, but with a smooth
	// sliding animation. Fires `movestart` and `moveend` events.
	slideTo: function slideTo(latlng, options) {
		if (!this._map) return;

        var duration = Number(options.duration);
		this._slideToDuration = duration;
		this._slideToUntil    = performance.now() + duration;
		this._slideFromLatLng = this.getLatLng();
		this._slideToLatLng   = latlng;
		this._slideKeepAtCenter = !!options.keepAtCenter;
		this._slideDraggingWasAllowed =
			this._slideDraggingWasAllowed !== undefined ?
				this._slideDraggingWasAllowed :
				this._map.dragging.enabled();

		if (this._slideKeepAtCenter) {
			this._map.dragging.disable();
			this._map.doubleClickZoom.disable();
			this._map.options.touchZoom = 'center';
			this._map.options.scrollWheelZoom = 'center';
		}

		this.fire('movestart');
		this._slideTo();

		return this;
	},

	// method slideCancel(): this
	// Cancels the sliding animation from `slideTo`, if applicable.
	slideCancel: function slideCancel() {
		L.Util.cancelAnimFrame(this._slideFrame);
	},

	_slideTo: function _slideTo() {
		if (!this._map) return;

		var remaining = this._slideToUntil - performance.now();

		if (remaining < 0) {
			this.setLatLng(this._slideToLatLng);
			this.fire('moveend');
			if (this._slideDraggingWasAllowed ) {
				this._map.dragging.enable();
				this._map.doubleClickZoom.enable();
				this._map.options.touchZoom = true;
				this._map.options.scrollWheelZoom = true;
			}
			this._slideDraggingWasAllowed = undefined;
			return this;
		}

		var startPoint = this._map.latLngToContainerPoint(this._slideFromLatLng);
		var endPoint   = this._map.latLngToContainerPoint(this._slideToLatLng);
		var percentDone = (this._slideToDuration - remaining) / this._slideToDuration;

		var currPoint = endPoint.multiplyBy(percentDone).add(
			startPoint.multiplyBy(1 - percentDone)
		);
		var currLatLng = this._map.containerPointToLatLng(currPoint)
		this.setLatLng(currLatLng);

		if (this._slideKeepAtCenter) {
			this._map.panTo(currLatLng, {animate: false})
		}

		this._slideFrame = L.Util.requestAnimFrame(this._slideTo, this);
	}

});

L.Marker.addInitHook(function(){
	this.on('move', this.slideCancel, this);
});

// class CircleMarker
L.CircleMarker.include({
	// method slideTo(latlng: LatLng, options: Slide Options): this
	// Moves this circle until `latlng`, like `setLatLng()`, but with a smooth
	// sliding animation. Fires `movestart` and `moveend` events.
	slideTo: L.Marker.prototype.slideTo,
	// method slideCancel(): this
	// Cancels the sliding animation from `slideTo`, if applicable.
	slideCancel: L.Marker.prototype.slideCancel,
	_slideTo: L.Marker.prototype._slideTo
});

L.CircleMarker.addInitHook(function(){
	this.on('move', this.slideCancel, this);
});
