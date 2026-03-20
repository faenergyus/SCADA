/**
 * Dyno Card Pattern Database & Diagnostic Engine
 *
 * Classifies downhole dynamometer cards by comparing shape features
 * against known pump condition patterns. Uses geometric analysis
 * (area ratios, load transitions, symmetry) rather than image matching.
 *
 * Sources:
 *   - Theta/XSPOC XDiag condition taxonomy
 *   - API RP 11L2 "Recommended Practice for Electrical Submersible Pump Testing"
 *   - Gibbs, S.G. "Computing Gearbox Torque and Motor Loading" (SPE 18186)
 *   - Industry standard card shape classifications
 */

const CardPatterns = (function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Pattern Database
    // -----------------------------------------------------------------------
    /**
     * Each pattern describes the expected shape features of a downhole card
     * for a specific pump condition.
     *
     * Shape features extracted from each card:
     *   - areaRatio:        actual card area / ideal rectangular card area
     *   - loadRange:        (maxLoad - minLoad) as fraction of ideal fluid load
     *   - upstrokeSlope:    normalized slope of load during upstroke
     *   - downstrokeSlope:  normalized slope of load during downstroke
     *   - tvTransition:     sharpness of load pickup at bottom (TV closing)
     *   - svTransition:     sharpness of load drop at top (SV closing)
     *   - symmetry:         how symmetric the card is about the midpoint
     *   - flatTop:          fraction of upstroke at near-constant load
     *   - flatBottom:       fraction of downstroke at near-constant load
     *   - fluidPoundIdx:    sharp load drop during downstroke (0-1)
     *   - gasCompression:   gradual load buildup during upstroke (0-1)
     */
    var PATTERNS = [
        {
            id: 'full_pump',
            name: 'Full Pump',
            severity: 'normal',
            description: 'Pump is operating normally with full fillage. Card is approximately rectangular.',
            operationalMeaning: 'Pump barrel is completely filled with fluid each stroke. Optimal production.',
            actions: ['No action needed', 'Monitor for changes'],
            features: {
                areaRatio: { min: 0.75, ideal: 0.90, max: 1.0 },
                flatTop: { min: 0.6, ideal: 0.85 },
                flatBottom: { min: 0.5, ideal: 0.80 },
                tvTransition: { min: 0.5, ideal: 0.9 },
                svTransition: { min: 0.5, ideal: 0.9 },
                fluidPoundIdx: { max: 0.15 },
                gasCompression: { max: 0.2 },
            },
            weight: 1.0,
        },
        {
            id: 'fluid_pound',
            name: 'Fluid Pound',
            severity: 'warning',
            description: 'Pump barrel not completely filled — plunger hits fluid on downstroke causing sharp load spike. Card shows truncated lower-right corner.',
            operationalMeaning: 'Pump speed exceeds fluid inflow rate. Barrel partially gas-filled. Causes rod and surface equipment fatigue.',
            actions: [
                'Slow pump speed (reduce SPM)',
                'Lower pump if possible',
                'Check for gas interference',
                'Verify fluid level vs pump depth',
            ],
            features: {
                areaRatio: { min: 0.3, ideal: 0.55, max: 0.75 },
                fluidPoundIdx: { min: 0.4, ideal: 0.8 },
                flatTop: { min: 0.3, ideal: 0.6 },
                flatBottom: { max: 0.4 },
            },
            weight: 1.2,
        },
        {
            id: 'gas_interference',
            name: 'Gas Interference',
            severity: 'warning',
            description: 'Free gas in pump barrel compresses before valves transfer. Card shows gradual load buildup on upstroke and gradual unloading on downstroke — "banana" or "football" shape.',
            operationalMeaning: 'Gas entering pump with fluid. Reduces pump efficiency. Gas must compress before TV opens.',
            actions: [
                'Install or check gas separator/anchor',
                'Lower pump below perforations if possible',
                'Consider gas venting',
                'Check casing pressure management',
            ],
            features: {
                areaRatio: { min: 0.35, ideal: 0.55, max: 0.75 },
                gasCompression: { min: 0.4, ideal: 0.7 },
                tvTransition: { max: 0.4 },
                svTransition: { max: 0.5 },
                flatTop: { max: 0.4 },
                flatBottom: { max: 0.4 },
            },
            weight: 1.1,
        },
        {
            id: 'tv_leak',
            name: 'Traveling Valve Leak',
            severity: 'warning',
            description: 'Traveling valve not seating properly. Fluid leaks past TV during upstroke. Card shows declining load during upstroke (sloping top).',
            operationalMeaning: 'TV ball or seat worn/damaged. Fluid falls back through TV during upstroke, reducing lift.',
            actions: [
                'Pull rods and replace TV',
                'Check for sand/debris in valve',
                'Monitor for worsening',
            ],
            features: {
                upstrokeSlope: { max: -0.15, ideal: -0.35 },
                flatTop: { max: 0.35 },
                areaRatio: { min: 0.4, max: 0.8 },
                tvTransition: { min: 0.3 },
            },
            weight: 1.15,
        },
        {
            id: 'sv_leak',
            name: 'Standing Valve Leak',
            severity: 'warning',
            description: 'Standing valve not seating properly. Fluid leaks past SV during downstroke. Card shows rising load during downstroke (sloping bottom).',
            operationalMeaning: 'SV ball or seat worn/damaged. Fluid falls back through SV during downstroke.',
            actions: [
                'Pull tubing and replace SV',
                'Check for sand/debris',
                'Verify SV type matches well conditions',
            ],
            features: {
                downstrokeSlope: { min: 0.15, ideal: 0.35 },
                flatBottom: { max: 0.35 },
                areaRatio: { min: 0.4, max: 0.8 },
                svTransition: { min: 0.3 },
            },
            weight: 1.15,
        },
        {
            id: 'worn_pump',
            name: 'Worn Pump / Barrel Wear',
            severity: 'caution',
            description: 'Pump barrel or plunger worn — fluid slips past plunger during both strokes. Card appears "squeezed" with reduced area but retains general shape.',
            operationalMeaning: 'Clearance between plunger and barrel increased. Efficiency drops progressively. Both valves may still be OK.',
            actions: [
                'Schedule pump replacement',
                'Monitor efficiency trend',
                'Check sand production levels',
            ],
            features: {
                areaRatio: { min: 0.45, ideal: 0.6, max: 0.75 },
                loadRange: { max: 0.7 },
                upstrokeSlope: { min: -0.25, max: -0.05 },
                downstrokeSlope: { min: 0.05, max: 0.25 },
            },
            weight: 1.0,
        },
        {
            id: 'rod_part',
            name: 'Rod Part (Broken Rod)',
            severity: 'critical',
            description: 'Rod string parted — surface carries only weight above break. Card shows minimal load variation, near-zero fluid load.',
            operationalMeaning: 'Rod broken. No pumping action at pump. Well is dead.',
            actions: [
                'Shut down unit immediately',
                'Fish rods',
                'Inspect rod string for cause (fatigue, corrosion, overload)',
            ],
            features: {
                areaRatio: { max: 0.15 },
                loadRange: { max: 0.25 },
                flatTop: { max: 0.2 },
                flatBottom: { max: 0.2 },
            },
            weight: 1.5,
        },
        {
            id: 'pump_hitting_down',
            name: 'Pump Hitting Down',
            severity: 'critical',
            description: 'Plunger bottoming out on downstroke — sharp load spike at bottom of stroke. Card shows spike in downstroke load near bottom dead center.',
            operationalMeaning: 'Plunger hitting bottom of barrel or tag bar. Causes rod buckling, barrel damage.',
            actions: [
                'Adjust rod space / rod length',
                'Check for tubing stretch',
                'Verify pump spacing',
                'Shut down if severe',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                bottomSpike: { min: 0.5, ideal: 0.8 },
            },
            weight: 1.3,
        },
        {
            id: 'bent_barrel',
            name: 'Bent Pump Barrel / Sticking Plunger',
            severity: 'caution',
            description: 'Plunger sticking or barrel bent — erratic load patterns, asymmetric card with humps.',
            operationalMeaning: 'Mechanical interference in pump. Barrel may be bent from installation or thermal effects.',
            actions: [
                'Pull and inspect pump',
                'Check for sand or scale buildup',
                'Verify tubing alignment',
            ],
            features: {
                symmetry: { max: 0.5 },
                areaRatio: { min: 0.3, max: 0.8 },
            },
            weight: 0.9,
        },
        {
            id: 'anchor_not_holding',
            name: 'Tubing Anchor Not Holding',
            severity: 'caution',
            description: 'Tubing moves with rod string because anchor is slipping. Card shifted or shows reduced net stroke due to tubing stretch.',
            operationalMeaning: 'Tubing anchor not gripping casing. Tubing reciprocates, absorbing pump stroke. Reduced production.',
            actions: [
                'Re-set tubing anchor',
                'Consider replacing anchor',
                'Check casing ID vs anchor size',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.85 },
                tubingMovement: { min: 0.3, ideal: 0.6 },
            },
            weight: 1.0,
        },
        {
            id: 'gas_lock',
            name: 'Gas Lock',
            severity: 'critical',
            description: 'Pump completely gas-locked — no fluid being pumped. Card collapses to a narrow sliver with almost no area.',
            operationalMeaning: 'Gas fills entire barrel. Neither valve can open because gas just compresses/expands. Zero production.',
            actions: [
                'Shut down and vent casing gas',
                'Install gas separator',
                'Lower pump below perfs',
                'Consider gas anchor modification',
            ],
            features: {
                areaRatio: { max: 0.12 },
                loadRange: { max: 0.2 },
                gasCompression: { min: 0.6 },
            },
            weight: 1.4,
        },
        {
            id: 'incomplete_fillage',
            name: 'Incomplete Pump Fillage',
            severity: 'info',
            description: 'Pump not fully filling each stroke — partial fluid pound. Less severe than full fluid pound.',
            operationalMeaning: 'Inflow rate slightly below pump displacement. Some gas or void space in barrel at start of upstroke.',
            actions: [
                'Consider slowing SPM slightly',
                'Monitor fluid level trend',
                'May be acceptable if production is near target',
            ],
            features: {
                areaRatio: { min: 0.6, ideal: 0.7, max: 0.82 },
                fluidPoundIdx: { min: 0.15, max: 0.5 },
                flatTop: { min: 0.4 },
            },
            weight: 0.8,
        },
        {
            id: 'phase_shift',
            name: 'Phase Shift in Card',
            severity: 'info',
            description: 'Card appears rotated/shifted — usually a sensor timing or calibration issue, not a pump problem.',
            operationalMeaning: 'Position encoder timing may be off, or load cell calibration drifted. Card shape is valid but phased.',
            actions: [
                'Recalibrate position sensor',
                'Check encoder alignment',
                'May indicate kinematic correction needed',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                phaseShift: { min: 0.3, ideal: 0.6 },
            },
            weight: 0.7,
        },
    ];

    // -----------------------------------------------------------------------
    // Feature Extraction
    // -----------------------------------------------------------------------

    /**
     * Extract shape features from a downhole card.
     *
     * @param {Array} position - Card position array (inches)
     * @param {Array} load     - Card load array (lbs)
     * @param {Object} rodModel - Optional rod model for reference values
     * @returns {Object} Feature vector
     */
    function extractFeatures(position, load, rodModel) {
        if (!position || !load || position.length < 10) return null;

        var N = Math.min(position.length, load.length);

        // Basic stats
        var minLoad = Infinity, maxLoad = -Infinity;
        var minPos = Infinity, maxPos = -Infinity;
        for (var i = 0; i < N; i++) {
            if (load[i] < minLoad) minLoad = load[i];
            if (load[i] > maxLoad) maxLoad = load[i];
            if (position[i] < minPos) minPos = position[i];
            if (position[i] > maxPos) maxPos = position[i];
        }

        var loadRange = maxLoad - minLoad;
        var posRange = maxPos - minPos;
        if (loadRange < 1 || posRange < 0.1) {
            return { areaRatio: 0, loadRange: 0, error: 'degenerate card' };
        }

        // Normalize to 0-1 range
        var normPos = [];
        var normLoad = [];
        for (var i = 0; i < N; i++) {
            normPos.push((position[i] - minPos) / posRange);
            normLoad.push((load[i] - minLoad) / loadRange);
        }

        // Card area (using shoelace formula on normalized card)
        var area = 0;
        for (var i = 0; i < N; i++) {
            var j = (i + 1) % N;
            area += normPos[i] * normLoad[j] - normPos[j] * normLoad[i];
        }
        area = Math.abs(area) / 2;
        var areaRatio = area;  // normalized area / 1.0 (ideal rectangle)

        // Find upstroke and downstroke segments
        // Upstroke: position increasing, Downstroke: position decreasing
        var upIndices = [];
        var downIndices = [];
        var midPos = 0.5;

        // Split card at approximate top and bottom of stroke
        var topIdx = 0, botIdx = 0;
        var topPos = 0, botPos = 1;
        for (var i = 0; i < N; i++) {
            if (normPos[i] > topPos) { topPos = normPos[i]; topIdx = i; }
            if (normPos[i] < botPos) { botPos = normPos[i]; botIdx = i; }
        }

        // Upstroke: from botIdx to topIdx (going forward, wrapping)
        for (var k = 0; k < N; k++) {
            var i = (botIdx + k) % N;
            upIndices.push(i);
            if (i === topIdx) break;
        }
        // Downstroke: from topIdx to botIdx
        for (var k = 0; k < N; k++) {
            var i = (topIdx + k) % N;
            downIndices.push(i);
            if (i === botIdx) break;
        }

        // Upstroke load slope (linear regression on upstroke load vs position)
        var upstrokeSlope = calcSlope(normPos, normLoad, upIndices);
        var downstrokeSlope = calcSlope(normPos, normLoad, downIndices);

        // Flat top: fraction of upstroke where load is within 15% of max upstroke load
        var maxUpLoad = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad) maxUpLoad = normLoad[upIndices[k]];
        }
        var flatTopCount = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad * 0.85) flatTopCount++;
        }
        var flatTop = upIndices.length > 0 ? flatTopCount / upIndices.length : 0;

        // Flat bottom: fraction of downstroke where load is within 15% of min downstroke load
        var minDownLoad = 1;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad) minDownLoad = normLoad[downIndices[k]];
        }
        var flatBotCount = 0;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad + 0.15) flatBotCount++;
        }
        var flatBottom = downIndices.length > 0 ? flatBotCount / downIndices.length : 0;

        // TV transition sharpness: how quickly load picks up at bottom of stroke
        var tvRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.15)));
        var tvTransition = 0;
        if (tvRegion.length > 1) {
            var loadJump = normLoad[tvRegion[tvRegion.length - 1]] - normLoad[tvRegion[0]];
            var posJump = normPos[tvRegion[tvRegion.length - 1]] - normPos[tvRegion[0]];
            tvTransition = posJump > 0.001 ? Math.min(1, loadJump / (posJump * 4)) : 0;
        }

        // SV transition sharpness: how quickly load drops at top of stroke
        var svRegion = downIndices.slice(0, Math.max(3, Math.floor(downIndices.length * 0.15)));
        var svTransition = 0;
        if (svRegion.length > 1) {
            var loadDrop = normLoad[svRegion[0]] - normLoad[svRegion[svRegion.length - 1]];
            var posDrop = normPos[svRegion[0]] - normPos[svRegion[svRegion.length - 1]];
            svTransition = Math.abs(posDrop) > 0.001 ? Math.min(1, loadDrop / (Math.abs(posDrop) * 4)) : 0;
        }

        // Fluid pound index: detect sharp load drop during downstroke
        var fluidPoundIdx = 0;
        if (downIndices.length > 5) {
            var maxDrop = 0;
            for (var k = 1; k < downIndices.length; k++) {
                var prevI = downIndices[k - 1];
                var curI = downIndices[k];
                var drop = normLoad[prevI] - normLoad[curI];
                if (drop > maxDrop) maxDrop = drop;
            }
            fluidPoundIdx = Math.min(1, maxDrop * 3);
        }

        // Gas compression: gradual load buildup (vs sharp TV transition)
        var gasCompression = Math.max(0, 1 - tvTransition);

        // Symmetry: compare first half vs second half shape
        var halfN = Math.floor(N / 2);
        var symDiff = 0;
        for (var i = 0; i < halfN; i++) {
            var mirrorI = N - 1 - i;
            symDiff += Math.abs(normLoad[i] - normLoad[mirrorI]);
        }
        var symmetry = halfN > 0 ? 1 - Math.min(1, symDiff / halfN) : 0.5;

        // Load range ratio (vs expected fluid load)
        var loadRangeRatio = 1.0;
        if (rodModel) {
            var plungerArea = Math.PI * rodModel.plungerDiam * rodModel.plungerDiam / 4;
            var expectedFluidLoad = rodModel.fluidSG * 0.433 * (rodModel.pumpDepth / 12) * plungerArea;
            if (expectedFluidLoad > 0) {
                loadRangeRatio = loadRange / expectedFluidLoad;
            }
        }

        // Bottom spike (pump hitting down)
        var bottomSpike = 0;
        var bottomRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.1)));
        if (bottomRegion.length > 1) {
            var spikeLoad = 0;
            for (var k = 0; k < bottomRegion.length; k++) {
                if (normLoad[bottomRegion[k]] > spikeLoad) spikeLoad = normLoad[bottomRegion[k]];
            }
            var avgUpLoad = 0;
            for (var k = 0; k < upIndices.length; k++) avgUpLoad += normLoad[upIndices[k]];
            avgUpLoad /= upIndices.length;
            if (spikeLoad > avgUpLoad * 1.3) bottomSpike = Math.min(1, (spikeLoad - avgUpLoad) * 3);
        }

        // Tubing movement: difference in position at same load levels
        var tubingMovement = 0;
        // Compare position at mid-load during upstroke vs downstroke
        var midLoadLevel = 0.5;
        var upMidPos = interpPosAtLoad(normPos, normLoad, upIndices, midLoadLevel);
        var downMidPos = interpPosAtLoad(normPos, normLoad, downIndices, midLoadLevel);
        if (upMidPos !== null && downMidPos !== null) {
            tubingMovement = Math.abs(upMidPos - downMidPos);
        }

        // Phase shift: detect if card is rotated from expected orientation
        var phaseShift = 0;
        // If max load occurs far from bottom of stroke or min load far from top
        var maxLoadPos = normPos[0];
        for (var i = 1; i < N; i++) {
            if (normLoad[i] === maxLoad) maxLoadPos = normPos[i];
        }
        if (maxLoadPos > 0.6 || maxLoadPos < 0.1) phaseShift = 0.5;

        return {
            areaRatio: areaRatio,
            loadRange: loadRangeRatio,
            upstrokeSlope: upstrokeSlope,
            downstrokeSlope: downstrokeSlope,
            tvTransition: tvTransition,
            svTransition: svTransition,
            flatTop: flatTop,
            flatBottom: flatBottom,
            fluidPoundIdx: fluidPoundIdx,
            gasCompression: gasCompression,
            symmetry: symmetry,
            bottomSpike: bottomSpike,
            tubingMovement: tubingMovement,
            phaseShift: phaseShift,
            // Raw stats for display
            _minLoad: minLoad,
            _maxLoad: maxLoad,
            _minPos: minPos,
            _maxPos: maxPos,
            _loadRange: loadRange,
            _posRange: posRange,
            _cardArea: area,
        };
    }

    function calcSlope(xArr, yArr, indices) {
        if (indices.length < 3) return 0;
        var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        var n = indices.length;
        for (var k = 0; k < n; k++) {
            var x = xArr[indices[k]];
            var y = yArr[indices[k]];
            sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
        }
        var denom = n * sumX2 - sumX * sumX;
        if (Math.abs(denom) < 1e-10) return 0;
        return (n * sumXY - sumX * sumY) / denom;
    }

    function interpPosAtLoad(normPos, normLoad, indices, targetLoad) {
        for (var k = 1; k < indices.length; k++) {
            var prev = indices[k - 1], cur = indices[k];
            var l0 = normLoad[prev], l1 = normLoad[cur];
            if ((l0 <= targetLoad && l1 >= targetLoad) || (l0 >= targetLoad && l1 <= targetLoad)) {
                if (Math.abs(l1 - l0) < 1e-10) return normPos[prev];
                var frac = (targetLoad - l0) / (l1 - l0);
                return normPos[prev] + frac * (normPos[cur] - normPos[prev]);
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Pattern Matching
    // -----------------------------------------------------------------------

    /**
     * Match extracted features against all patterns.
     * Returns ranked list of diagnoses with confidence scores.
     *
     * @param {Object} features - From extractFeatures()
     * @returns {Array} [{pattern, confidence, matchDetails}, ...] sorted by confidence desc
     */
    function diagnose(features) {
        if (!features || features.error) return [];

        var results = [];

        for (var p = 0; p < PATTERNS.length; p++) {
            var pattern = PATTERNS[p];
            var score = 0;
            var maxScore = 0;
            var details = {};

            var featureSpecs = pattern.features;
            for (var fName in featureSpecs) {
                if (!featureSpecs.hasOwnProperty(fName)) continue;

                var spec = featureSpecs[fName];
                var actual = features[fName];
                if (actual === undefined || actual === null) continue;

                maxScore += 1;
                var featureScore = 0;

                // Check if within range
                var inRange = true;
                if (spec.min !== undefined && actual < spec.min) inRange = false;
                if (spec.max !== undefined && actual > spec.max) inRange = false;

                if (inRange) {
                    featureScore = 0.5;  // base score for being in range

                    // Bonus for being near ideal
                    if (spec.ideal !== undefined) {
                        var dist = Math.abs(actual - spec.ideal);
                        var range = 1.0;
                        if (spec.min !== undefined && spec.max !== undefined) {
                            range = spec.max - spec.min;
                        } else if (spec.min !== undefined) {
                            range = Math.max(1, spec.ideal - spec.min) * 2;
                        } else if (spec.max !== undefined) {
                            range = Math.max(1, spec.max - spec.ideal) * 2;
                        }
                        featureScore += 0.5 * Math.max(0, 1 - dist / Math.max(range, 0.01));
                    } else {
                        featureScore = 0.8;  // just in range, no ideal specified
                    }
                }

                score += featureScore;
                details[fName] = {
                    actual: Math.round(actual * 1000) / 1000,
                    spec: spec,
                    match: featureScore > 0.3,
                    score: Math.round(featureScore * 100) / 100,
                };
            }

            var confidence = maxScore > 0 ? (score / maxScore) * pattern.weight : 0;
            confidence = Math.min(1, confidence);

            if (confidence > 0.2) {
                results.push({
                    pattern: pattern,
                    confidence: Math.round(confidence * 100) / 100,
                    matchDetails: details,
                });
            }
        }

        // Sort by confidence descending
        results.sort(function (a, b) { return b.confidence - a.confidence; });

        return results;
    }

    /**
     * Get a human-readable diagnosis summary.
     *
     * @param {Array} position - Downhole card position
     * @param {Array} load     - Downhole card load
     * @param {Object} rodModel - Optional rod model
     * @returns {Object} {primary, secondary, features, allMatches}
     */
    function analyzeCard(position, load, rodModel) {
        var features = extractFeatures(position, load, rodModel);
        if (!features) return { primary: null, error: 'Could not extract features' };

        var matches = diagnose(features);

        return {
            primary: matches.length > 0 ? matches[0] : null,
            secondary: matches.length > 1 ? matches[1] : null,
            features: features,
            allMatches: matches,
        };
    }

    // Public API
    return {
        PATTERNS: PATTERNS,
        extractFeatures: extractFeatures,
        diagnose: diagnose,
        analyzeCard: analyzeCard,
    };
})();
